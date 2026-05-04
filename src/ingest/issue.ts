import { createHash } from "node:crypto";
import { z } from "zod";
import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import { paginate, gh } from "../clients/github.ts";
import { isBot } from "./bot.ts";
import { upsertUser } from "./user.ts";
import { upsertLabelsAndEdges } from "./labels.ts";
import { createContent, updateSet } from "../clients/surreal_helpers.ts";
import type { ParsedUser, ParsedLabel, RepoRef } from "./types.ts";

export type ParsedIssue = {
  github_node_id: string;
  github_url: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  state_reason: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  content_hash: string;
  author: ParsedUser | null;
  labels: ParsedLabel[];
};

const LabelNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

const LabelConnectionSchema = z.object({
  nodes: z.array(LabelNodeSchema),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
});

const AuthorSchema = z
  .object({
    __typename: z.string(),
    id: z.string().optional(),
    login: z.string(),
    url: z.string(),
  })
  .nullable();

const IssueNodeSchema = z.object({
  id: z.string(),
  url: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: AuthorSchema,
  labels: LabelConnectionSchema,
});

const ISSUES_QUERY = `
  query FetchIssues($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id url number title body state stateReason closedAt createdAt updatedAt
          author {
            __typename
            login
            url
            ... on User { id }
            ... on Bot { id }
          }
          labels(first: 50) {
            nodes { id name color description }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

const LABELS_QUERY = `
  query FetchIssueLabels($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        labels(first: 50, after: $cursor) {
          nodes { id name color description }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export function computeContentHash(title: string, rawBody: string | null): string {
  const normalizedBody = (rawBody ?? "").replace(/\r\n/g, "\n");
  return createHash("sha256")
    .update(`${title}\n\n${normalizedBody}`)
    .digest("hex");
}

export async function* fetchIssues(owner: string, name: string): AsyncGenerator<ParsedIssue> {
  for await (const rawNode of paginate(
    ISSUES_QUERY,
    { owner, name },
    (data: unknown) => {
      const d = data as {
        repository: {
          issues: {
            nodes: unknown[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      return d.repository.issues;
    },
  )) {
    const node = IssueNodeSchema.parse(rawNode);

    let author: ParsedUser | null = null;
    if (node.author !== null) {
      const { __typename, id, login, url: github_url } = node.author;
      if ((__typename === "User" || __typename === "Bot") && id !== undefined) {
        author = {
          github_node_id: id,
          login,
          is_bot: isBot(__typename, login),
          github_url,
        };
      }
    }

    let labelNodes = node.labels.nodes;
    let labelPageInfo = node.labels.pageInfo;

    while (labelPageInfo.hasNextPage) {
      const moreData = await gh<unknown>(LABELS_QUERY, {
        owner,
        name,
        number: node.number,
        cursor: labelPageInfo.endCursor,
      });
      const moreConn = (
        moreData as { repository: { issue: { labels: unknown } } }
      ).repository.issue.labels;
      const moreParsed = LabelConnectionSchema.parse(moreConn);
      labelNodes = [...labelNodes, ...moreParsed.nodes];
      labelPageInfo = moreParsed.pageInfo;
    }

    const labels: ParsedLabel[] = labelNodes.map((l) => ({
      github_node_id: l.id,
      name: l.name,
      color: l.color,
      description: l.description,
    }));

    const content_hash = computeContentHash(node.title, node.body);

    yield {
      github_node_id: node.id,
      github_url: node.url,
      number: node.number,
      title: node.title,
      body: (node.body ?? "").replace(/\r\n/g, "\n"),
      state: node.state,
      state_reason: node.stateReason,
      closed_at: node.closedAt ? new Date(node.closedAt) : null,
      created_at: new Date(node.createdAt),
      updated_at: new Date(node.updatedAt),
      content_hash,
      author,
      labels,
    };
  }
}

export async function persistIssue(
  db: Surreal,
  repo: RepoRef,
  parsed: ParsedIssue,
): Promise<void> {
  const repoRef = new StringRecordId(repo.id);

  let authorRef: StringRecordId | undefined;
  if (parsed.author !== null) {
    const id = await upsertUser(db, parsed.author);
    authorRef = new StringRecordId(id);
  }

  const [existing] = await db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM issue WHERE github_node_id = $github_node_id",
    { github_node_id: parsed.github_node_id },
  );

  let issueRecordId: string;

  if (existing.length === 0) {
    const content = createContent({
      github_node_id: parsed.github_node_id,
      github_url: parsed.github_url,
      repo: repoRef,
      number: parsed.number,
      title: parsed.title,
      body: parsed.body,
      state: parsed.state,
      state_reason: parsed.state_reason,
      author: authorRef ?? null,
      closed_at: parsed.closed_at,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      deleted_at: null,
      content_hash: parsed.content_hash,
      embedding: null,
    });
    const [created] = await db.query<[Array<{ id: unknown }>]>(
      `CREATE issue CONTENT ${content.sql}`,
      content.params,
    );
    issueRecordId = String(created[0].id);
  } else {
    issueRecordId = String(existing[0].id);
    const set = updateSet({
      github_url: parsed.github_url,
      title: parsed.title,
      body: parsed.body,
      state: parsed.state,
      state_reason: parsed.state_reason,
      author: authorRef ?? null,
      closed_at: parsed.closed_at,
      updated_at: parsed.updated_at,
      content_hash: parsed.content_hash,
    });
    await db.query(
      `UPDATE $id ${set.sql}`,
      { id: new StringRecordId(issueRecordId), ...set.params },
    );
  }

  await upsertLabelsAndEdges(db, issueRecordId, parsed.labels);
}
