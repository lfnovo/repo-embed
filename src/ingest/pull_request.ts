import { z } from "zod";
import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import { paginate, gh } from "../clients/github.ts";
import { isBot } from "./bot.ts";
import { computeContentHash } from "./issue.ts";
import { upsertUser } from "./user.ts";
import { upsertLabelsAndEdges } from "./labels.ts";
import { linkClosingIssues } from "./crossrefs.ts";
import { createContent, updateSet } from "../clients/surreal_helpers.ts";
import type { ParsedUser, ParsedLabel, RepoRef } from "./types.ts";

export type ParsedCommit = {
  github_node_id: string;
  oid: string;
  github_url: string;
  message_headline: string;
  message_body: string | null;
  committed_date: Date;
  author: ParsedUser | null;
};

export type ParsedPullRequest = {
  github_node_id: string;
  github_url: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  closed_at: Date | null;
  merged_at: Date | null;
  created_at: Date;
  updated_at: Date;
  content_hash: string;
  author: ParsedUser | null;
  labels: ParsedLabel[];
  commits: ParsedCommit[];
  closing_issue_node_ids: string[];
};

const AuthorSchema = z
  .object({
    __typename: z.string(),
    id: z.string().optional(),
    login: z.string(),
    url: z.string(),
  })
  .nullable();

const CommitAuthorUserSchema = z
  .object({
    __typename: z.string(),
    id: z.string(),
    login: z.string(),
    url: z.string(),
  })
  .nullable();

const CommitSchema = z.object({
  id: z.string(),
  url: z.string(),
  oid: z.string(),
  messageHeadline: z.string(),
  messageBody: z.string().nullable(),
  committedDate: z.string(),
  author: z.object({ user: CommitAuthorUserSchema }),
});

const CommitNodeSchema = z.object({ commit: CommitSchema });

const CommitConnectionSchema = z.object({
  nodes: z.array(CommitNodeSchema),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
});

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

const PullRequestNodeSchema = z.object({
  id: z.string(),
  url: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  closedAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
  // mergedBy is fetched from GitHub but not written to DB — schema has no merged_by column; deferred
  mergedBy: AuthorSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: AuthorSchema,
  labels: LabelConnectionSchema,
  commits: CommitConnectionSchema,
  closingIssuesReferences: z.object({
    nodes: z.array(z.object({ id: z.string() })),
  }),
});

const PULL_REQUESTS_QUERY = `
  query FetchPullRequests($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        states: [OPEN, CLOSED, MERGED],
        orderBy: { field: UPDATED_AT, direction: ASC },
        first: 50,
        after: $cursor
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id url number title body state
          closedAt mergedAt createdAt updatedAt
          mergedBy {
            __typename login url
            ... on User { id }
            ... on Bot  { id }
          }
          author {
            __typename login url
            ... on User { id }
            ... on Bot  { id }
          }
          labels(first: 50) {
            nodes { id name color description }
            pageInfo { hasNextPage endCursor }
          }
          commits(first: 100) {
            nodes {
              commit {
                id url oid messageHeadline messageBody committedDate
                author { user { __typename id login url } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
          closingIssuesReferences(first: 50) {
            nodes { id }
          }
        }
      }
    }
  }
`;

const PR_COMMITS_QUERY = `
  query FetchPRCommits($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        commits(first: 100, after: $cursor) {
          nodes {
            commit {
              id url oid messageHeadline messageBody committedDate
              author { user { __typename id login url } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export async function* fetchPullRequests(
  owner: string,
  name: string,
): AsyncGenerator<ParsedPullRequest> {
  for await (const rawNode of paginate(
    PULL_REQUESTS_QUERY,
    { owner, name },
    (data: unknown) => {
      const d = data as {
        repository: {
          pullRequests: {
            nodes: unknown[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      return d.repository.pullRequests;
    },
  )) {
    const node = PullRequestNodeSchema.parse(rawNode);

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

    let commitNodes = node.commits.nodes;
    let commitPageInfo = node.commits.pageInfo;

    while (commitPageInfo.hasNextPage) {
      const moreData = await gh<unknown>(PR_COMMITS_QUERY, {
        owner,
        name,
        number: node.number,
        cursor: commitPageInfo.endCursor,
      });
      const moreConn = CommitConnectionSchema.parse(
        (moreData as { repository: { pullRequest: { commits: unknown } } })
          .repository.pullRequest.commits,
      );
      commitNodes = [...commitNodes, ...moreConn.nodes];
      commitPageInfo = moreConn.pageInfo;
    }

    const commits: ParsedCommit[] = commitNodes.map((cn) => {
      const c = cn.commit;
      let commitAuthor: ParsedUser | null = null;
      const user = c.author.user;
      if (user !== null && (user.__typename === "User" || user.__typename === "Bot")) {
        commitAuthor = {
          github_node_id: user.id,
          login: user.login,
          is_bot: isBot(user.__typename as "User" | "Bot", user.login),
          github_url: user.url,
        };
      }
      return {
        github_node_id: c.id,
        oid: c.oid,
        github_url: c.url,
        message_headline: c.messageHeadline,
        message_body: c.messageBody,
        committed_date: new Date(c.committedDate),
        author: commitAuthor,
      };
    });

    const labels: ParsedLabel[] = node.labels.nodes.map((l) => ({
      github_node_id: l.id,
      name: l.name,
      color: l.color,
      description: l.description,
    }));

    const closing_issue_node_ids = node.closingIssuesReferences.nodes.map((n) => n.id);

    const content_hash = computeContentHash(node.title, node.body);

    yield {
      github_node_id: node.id,
      github_url: node.url,
      number: node.number,
      title: node.title,
      body: (node.body ?? "").replace(/\r\n/g, "\n"),
      state: node.state,
      closed_at: node.closedAt ? new Date(node.closedAt) : null,
      merged_at: node.mergedAt ? new Date(node.mergedAt) : null,
      created_at: new Date(node.createdAt),
      updated_at: new Date(node.updatedAt),
      content_hash,
      author,
      labels,
      commits,
      closing_issue_node_ids,
    };
  }
}

export async function persistPullRequest(
  db: Surreal,
  repo: RepoRef,
  parsed: ParsedPullRequest,
): Promise<void> {
  const repoRef = new StringRecordId(repo.id);

  // 1. Upsert PR author
  let authorRef: StringRecordId | undefined;
  if (parsed.author !== null) {
    const id = await upsertUser(db, parsed.author);
    authorRef = new StringRecordId(id);
  }

  // 2. Lookup PR by github_node_id; CREATE or UPDATE
  const [existing] = await db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM pull_request WHERE github_node_id = $github_node_id",
    { github_node_id: parsed.github_node_id },
  );

  let prRecordId: string;

  if (existing.length === 0) {
    const content = createContent({
      github_node_id: parsed.github_node_id,
      github_url: parsed.github_url,
      repo: repoRef,
      number: parsed.number,
      title: parsed.title,
      body: parsed.body,
      state: parsed.state,
      author: authorRef ?? null,
      merged_at: parsed.merged_at,
      closed_at: parsed.closed_at,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      deleted_at: null,
      content_hash: parsed.content_hash,
      embedding: null,
    });
    const [created] = await db.query<[Array<{ id: unknown }>]>(
      `CREATE pull_request CONTENT ${content.sql}`,
      content.params,
    );
    prRecordId = String(created[0].id);
  } else {
    prRecordId = String(existing[0].id);
    const set = updateSet({
      github_url: parsed.github_url,
      title: parsed.title,
      body: parsed.body,
      state: parsed.state,
      author: authorRef ?? null,
      merged_at: parsed.merged_at,
      closed_at: parsed.closed_at,
      updated_at: parsed.updated_at,
      content_hash: parsed.content_hash,
    });
    await db.query(
      `UPDATE $id ${set.sql}`,
      { id: new StringRecordId(prRecordId), ...set.params },
    );
  }

  const prRef = new StringRecordId(prRecordId);

  // 3. For each commit: upsert author, upsert commit, relate pr→contains_commit→commit
  for (const commit of parsed.commits) {
    let commitAuthorRef: StringRecordId | undefined;
    if (commit.author !== null) {
      const commitUserId = await upsertUser(db, commit.author);
      commitAuthorRef = new StringRecordId(commitUserId);
    }

    const [existingCommit] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM commit WHERE github_node_id = $github_node_id",
      { github_node_id: commit.github_node_id },
    );

    let commitRecordId: string;

    if (existingCommit.length === 0) {
      const commitContent = createContent({
        github_node_id: commit.github_node_id,
        github_url: commit.github_url,
        repo: repoRef,
        oid: commit.oid,
        message_headline: commit.message_headline,
        message_body: commit.message_body,
        author: commitAuthorRef ?? null,
        committed_date: commit.committed_date,
        deleted_at: null,
      });
      const [createdCommit] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE commit CONTENT ${commitContent.sql.slice(0, -2)}, created_at: time::now(), updated_at: time::now() }`,
        commitContent.params,
      );
      commitRecordId = String(createdCommit[0].id);
    } else {
      commitRecordId = String(existingCommit[0].id);
      const commitSet = updateSet({
        github_url: commit.github_url,
        message_headline: commit.message_headline,
        message_body: commit.message_body,
        author: commitAuthorRef ?? null,
        committed_date: commit.committed_date,
      });
      await db.query(
        `UPDATE $id ${commitSet.sql}, updated_at = time::now()`,
        { id: new StringRecordId(commitRecordId), ...commitSet.params },
      );
    }

    const commitRef = new StringRecordId(commitRecordId);

    const [edges] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM contains_commit WHERE in = $prRef AND out = $commitRef",
      { prRef, commitRef },
    );

    if (edges.length === 0) {
      await db.query(
        "RELATE $prRef->contains_commit->$commitRef CONTENT { created_at: time::now() }",
        { prRef, commitRef },
      );
    }
  }

  // 4. Upsert labels and edges
  await upsertLabelsAndEdges(db, prRecordId, parsed.labels);

  // 5. Link closing issues
  await linkClosingIssues(db, prRecordId, parsed.closing_issue_node_ids);
}
