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

export type ParsedDiscussion = {
  github_node_id: string;
  github_url: string;
  number: number;
  title: string;
  body: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  content_hash: string;
  category_name: string | null;
  answer_chosen_at: Date | null;
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

const DiscussionNodeSchema = z.object({
  id: z.string(),
  url: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: AuthorSchema,
  category: z
    .object({
      name: z.string(),
      emoji: z.string(),
      isAnswerable: z.boolean(),
    })
    .nullable(),
  answer: z.object({ id: z.string() }).nullable(),
  answerChosenAt: z.string().nullable(),
  labels: LabelConnectionSchema,
});

const DISCUSSIONS_PROBE_QUERY = `
  query DiscussionsProbe($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      hasDiscussionsEnabled
    }
  }
`;

const DISCUSSIONS_QUERY = `
  query FetchDiscussions($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussions(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id url number title body closedAt createdAt updatedAt
          author {
            __typename
            login
            url
            ... on User { id }
            ... on Bot { id }
          }
          category { name emoji isAnswerable }
          answer { id }
          answerChosenAt
          labels(first: 50) {
            nodes { id name color description }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

const DISCUSSION_LABELS_QUERY = `
  query FetchDiscussionLabels($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussion(number: $number) {
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

export async function* fetchDiscussions(
  owner: string,
  name: string,
  since?: Date,
): AsyncGenerator<ParsedDiscussion> {
  const probeData = await gh<{ repository: { hasDiscussionsEnabled: boolean } }>(
    DISCUSSIONS_PROBE_QUERY,
    { owner, name },
  );
  if (!probeData.repository.hasDiscussionsEnabled) return;

  for await (const rawNode of paginate(
    DISCUSSIONS_QUERY,
    { owner, name },
    (data: unknown) => {
      const d = data as {
        repository: {
          discussions: {
            nodes: unknown[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      return d.repository.discussions;
    },
  )) {
    const node = DiscussionNodeSchema.parse(rawNode);
    if (since && new Date(node.updatedAt) <= since) break;

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
      const moreData = await gh<unknown>(DISCUSSION_LABELS_QUERY, {
        owner,
        name,
        number: node.number,
        cursor: labelPageInfo.endCursor,
      });
      const moreConn = (
        moreData as { repository: { discussion: { labels: unknown } } }
      ).repository.discussion.labels;
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
      closed_at: node.closedAt ? new Date(node.closedAt) : null,
      created_at: new Date(node.createdAt),
      updated_at: new Date(node.updatedAt),
      content_hash,
      category_name: node.category?.name ?? null,
      answer_chosen_at: node.answerChosenAt ? new Date(node.answerChosenAt) : null,
      author,
      labels,
    };
  }
}

export async function persistDiscussion(
  db: Surreal,
  repo: RepoRef,
  parsed: ParsedDiscussion,
): Promise<void> {
  const repoRef = new StringRecordId(repo.id);

  let authorRef: StringRecordId | undefined;
  if (parsed.author !== null) {
    const id = await upsertUser(db, parsed.author);
    authorRef = new StringRecordId(id);
  }

  const [existing] = await db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM discussion WHERE github_node_id = $github_node_id",
    { github_node_id: parsed.github_node_id },
  );

  let discussionRecordId: string;

  if (existing.length === 0) {
    const content = createContent({
      github_node_id: parsed.github_node_id,
      github_url: parsed.github_url,
      repo: repoRef,
      number: parsed.number,
      title: parsed.title,
      body: parsed.body,
      category: parsed.category_name,
      author: authorRef ?? null,
      answer_chosen_at: parsed.answer_chosen_at,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      deleted_at: null,
      content_hash: parsed.content_hash,
      embedding: null,
    });
    const [created] = await db.query<[Array<{ id: unknown }>]>(
      `CREATE discussion CONTENT ${content.sql}`,
      content.params,
    );
    discussionRecordId = String(created[0].id);
  } else {
    discussionRecordId = String(existing[0].id);
    const set = updateSet({
      github_url: parsed.github_url,
      title: parsed.title,
      body: parsed.body,
      category: parsed.category_name,
      author: authorRef ?? null,
      answer_chosen_at: parsed.answer_chosen_at,
      updated_at: parsed.updated_at,
      content_hash: parsed.content_hash,
    });
    await db.query(
      `UPDATE $id ${set.sql}`,
      { id: new StringRecordId(discussionRecordId), ...set.params },
    );
  }

  await upsertLabelsAndEdges(db, discussionRecordId, parsed.labels);
}

export async function resolveDiscussionAnswerLinks(
  db: Surreal,
  repo: RepoRef,
): Promise<{ resolved: number; pending: number }> {
  // TODO: requires schema additions for answer_node_id + answer record link
  void db;
  void repo;
  return { resolved: 0, pending: 0 };
}
