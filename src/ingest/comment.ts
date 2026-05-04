import { createHash } from "node:crypto";
import { z } from "zod";
import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import { paginate, gh } from "../clients/github.ts";
import { isBot } from "./bot.ts";
import { upsertUser } from "./user.ts";
import type { ParsedUser } from "./types.ts";

export type ParsedComment = {
  github_node_id: string;
  github_url: string;
  body: string;
  created_at: Date;
  updated_at: Date;
  content_hash: string;
  author: ParsedUser | null;
  parent_kind: "issue" | "pull_request" | "discussion";
  parent_node_id: string;
  parent_comment_node_id: string | null;
};

export function hashBody(rawBody: string | null): string {
  const normalizedBody = (rawBody ?? "").replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalizedBody).digest("hex");
}

const AuthorSchema = z
  .object({
    __typename: z.string(),
    id: z.string().optional(),
    login: z.string(),
    url: z.string(),
  })
  .nullable();

const CommentNodeSchema = z.object({
  id: z.string(),
  url: z.string(),
  body: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: AuthorSchema,
});

const ReplyConnectionSchema = z.object({
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
  nodes: z.array(CommentNodeSchema),
});

const DiscussionCommentNodeSchema = CommentNodeSchema.extend({
  replies: ReplyConnectionSchema,
});

function parseAuthor(raw: z.infer<typeof AuthorSchema>): ParsedUser | null {
  if (raw === null) return null;
  const { __typename, id, login, url: github_url } = raw;
  if ((__typename === "User" || __typename === "Bot") && id !== undefined) {
    return {
      github_node_id: id,
      login,
      is_bot: isBot(__typename, login),
      github_url,
    };
  }
  return null;
}

const ISSUE_COMMENTS_QUERY = `
  query FetchIssueComments($owner: String!, $name: String!, $issueNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        id
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id url body createdAt updatedAt
            author {
              __typename login url
              ... on User { id }
              ... on Bot { id }
            }
          }
        }
      }
    }
  }
`;

const PR_COMMENTS_QUERY = `
  query FetchPRComments($owner: String!, $name: String!, $prNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $prNumber) {
        id
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id url body createdAt updatedAt
            author {
              __typename login url
              ... on User { id }
              ... on Bot { id }
            }
          }
        }
      }
    }
  }
`;

const DISCUSSION_COMMENTS_QUERY = `
  query FetchDiscussionComments($owner: String!, $name: String!, $discussionNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussion(number: $discussionNumber) {
        id
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id url body createdAt updatedAt
            author {
              __typename login url
              ... on User { id }
              ... on Bot { id }
            }
            replies(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id url body createdAt updatedAt
                author {
                  __typename login url
                  ... on User { id }
                  ... on Bot { id }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const DISCUSSION_COMMENT_REPLIES_QUERY = `
  query FetchDiscussionCommentReplies($nodeId: ID!, $cursor: String) {
    node(id: $nodeId) {
      ... on DiscussionComment {
        replies(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id url body createdAt updatedAt
            author {
              __typename login url
              ... on User { id }
              ... on Bot { id }
            }
          }
        }
      }
    }
  }
`;

export async function* fetchCommentsForIssue(
  owner: string,
  name: string,
  issueNumber: number,
): AsyncGenerator<ParsedComment> {
  let parentNodeId = "";
  for await (const rawNode of paginate(
    ISSUE_COMMENTS_QUERY,
    { owner, name, issueNumber },
    (data: unknown) => {
      const d = data as {
        repository: {
          issue: {
            id: string;
            comments: {
              nodes: unknown[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
      parentNodeId = d.repository.issue.id;
      return d.repository.issue.comments;
    },
  )) {
    const node = CommentNodeSchema.parse(rawNode);
    yield {
      github_node_id: node.id,
      github_url: node.url,
      body: (node.body ?? "").replace(/\r\n/g, "\n"),
      created_at: new Date(node.createdAt),
      updated_at: new Date(node.updatedAt),
      content_hash: hashBody(node.body),
      author: parseAuthor(node.author),
      parent_kind: "issue",
      parent_node_id: parentNodeId,
      parent_comment_node_id: null,
    };
  }
}

export async function* fetchCommentsForPullRequest(
  owner: string,
  name: string,
  prNumber: number,
): AsyncGenerator<ParsedComment> {
  let parentNodeId = "";
  for await (const rawNode of paginate(
    PR_COMMENTS_QUERY,
    { owner, name, prNumber },
    (data: unknown) => {
      const d = data as {
        repository: {
          pullRequest: {
            id: string;
            comments: {
              nodes: unknown[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
      parentNodeId = d.repository.pullRequest.id;
      return d.repository.pullRequest.comments;
    },
  )) {
    const node = CommentNodeSchema.parse(rawNode);
    yield {
      github_node_id: node.id,
      github_url: node.url,
      body: (node.body ?? "").replace(/\r\n/g, "\n"),
      created_at: new Date(node.createdAt),
      updated_at: new Date(node.updatedAt),
      content_hash: hashBody(node.body),
      author: parseAuthor(node.author),
      parent_kind: "pull_request",
      parent_node_id: parentNodeId,
      parent_comment_node_id: null,
    };
  }
}

export async function* fetchCommentsForDiscussion(
  owner: string,
  name: string,
  discussionNumber: number,
): AsyncGenerator<ParsedComment> {
  let parentNodeId = "";
  for await (const rawNode of paginate(
    DISCUSSION_COMMENTS_QUERY,
    { owner, name, discussionNumber },
    (data: unknown) => {
      const d = data as {
        repository: {
          discussion: {
            id: string;
            comments: {
              nodes: unknown[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
      parentNodeId = d.repository.discussion.id;
      return d.repository.discussion.comments;
    },
  )) {
    const node = DiscussionCommentNodeSchema.parse(rawNode);

    yield {
      github_node_id: node.id,
      github_url: node.url,
      body: (node.body ?? "").replace(/\r\n/g, "\n"),
      created_at: new Date(node.createdAt),
      updated_at: new Date(node.updatedAt),
      content_hash: hashBody(node.body),
      author: parseAuthor(node.author),
      parent_kind: "discussion",
      parent_node_id: parentNodeId,
      parent_comment_node_id: null,
    };

    let replyNodes = node.replies.nodes;
    let replyPageInfo = node.replies.pageInfo;

    while (replyPageInfo.hasNextPage) {
      const moreData = await gh<unknown>(DISCUSSION_COMMENT_REPLIES_QUERY, {
        nodeId: node.id,
        cursor: replyPageInfo.endCursor,
      });
      const moreConn = ReplyConnectionSchema.parse(
        (moreData as { node: { replies: unknown } }).node.replies,
      );
      replyNodes = [...replyNodes, ...moreConn.nodes];
      replyPageInfo = moreConn.pageInfo;
    }

    for (const reply of replyNodes) {
      yield {
        github_node_id: reply.id,
        github_url: reply.url,
        body: (reply.body ?? "").replace(/\r\n/g, "\n"),
        created_at: new Date(reply.createdAt),
        updated_at: new Date(reply.updatedAt),
        content_hash: hashBody(reply.body),
        author: parseAuthor(reply.author),
        parent_kind: "discussion",
        parent_node_id: parentNodeId,
        parent_comment_node_id: node.id,
      };
    }
  }
}

export async function persistComment(db: Surreal, parsed: ParsedComment): Promise<void> {
  const parentTable =
    parsed.parent_kind === "pull_request"
      ? "pull_request"
      : parsed.parent_kind === "issue"
        ? "issue"
        : "discussion";

  const [parentRows] = await db.query<[Array<{ id: unknown }>]>(
    `SELECT id FROM ${parentTable} WHERE github_node_id = $node_id`,
    { node_id: parsed.parent_node_id },
  );
  if (parentRows.length === 0) {
    throw new Error(`parent not found: ${parsed.parent_node_id}`);
  }
  const parentRef = new StringRecordId(String(parentRows[0].id));

  let parentCommentRef: StringRecordId | undefined;
  if (parsed.parent_comment_node_id !== null) {
    const [pcRows] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM comment WHERE github_node_id = $node_id",
      { node_id: parsed.parent_comment_node_id },
    );
    if (pcRows.length === 0) {
      throw new Error(`parent not found: ${parsed.parent_comment_node_id}`);
    }
    parentCommentRef = new StringRecordId(String(pcRows[0].id));
  }

  let authorRef: StringRecordId | undefined;
  if (parsed.author !== null) {
    const id = await upsertUser(db, parsed.author);
    authorRef = new StringRecordId(id);
  }

  const authorSql = parsed.author !== null ? "$author" : "NONE";
  const parentIssueSql = parsed.parent_kind === "issue" ? "$parent_issue" : "NONE";
  const parentPrSql = parsed.parent_kind === "pull_request" ? "$parent_pr" : "NONE";
  const parentDiscussionSql = parsed.parent_kind === "discussion" ? "$parent_discussion" : "NONE";
  const parentCommentSql = parsed.parent_comment_node_id !== null ? "$parent_comment" : "NONE";

  const [existing] = await db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM comment WHERE github_node_id = $github_node_id",
    { github_node_id: parsed.github_node_id },
  );

  if (existing.length === 0) {
    await db.query(
      `CREATE comment CONTENT {
        github_node_id: $github_node_id,
        github_url: $github_url,
        parent_issue: ${parentIssueSql},
        parent_pr: ${parentPrSql},
        parent_discussion: ${parentDiscussionSql},
        parent_comment: ${parentCommentSql},
        author: ${authorSql},
        body: $body,
        created_at: $created_at,
        updated_at: $updated_at,
        deleted_at: NONE,
        content_hash: $content_hash,
        embedding: NONE
      }`,
      {
        github_node_id: parsed.github_node_id,
        github_url: parsed.github_url,
        ...(parsed.parent_kind === "issue" ? { parent_issue: parentRef } : {}),
        ...(parsed.parent_kind === "pull_request" ? { parent_pr: parentRef } : {}),
        ...(parsed.parent_kind === "discussion" ? { parent_discussion: parentRef } : {}),
        ...(parsed.parent_comment_node_id !== null ? { parent_comment: parentCommentRef } : {}),
        ...(parsed.author !== null ? { author: authorRef } : {}),
        body: parsed.body,
        created_at: parsed.created_at,
        updated_at: parsed.updated_at,
        content_hash: parsed.content_hash,
      },
    );
  } else {
    await db.query(
      `UPDATE $id SET
        github_url = $github_url,
        parent_issue = ${parentIssueSql},
        parent_pr = ${parentPrSql},
        parent_discussion = ${parentDiscussionSql},
        parent_comment = ${parentCommentSql},
        author = ${authorSql},
        body = $body,
        updated_at = $updated_at,
        content_hash = $content_hash`,
      {
        id: new StringRecordId(String(existing[0].id)),
        github_url: parsed.github_url,
        ...(parsed.parent_kind === "issue" ? { parent_issue: parentRef } : {}),
        ...(parsed.parent_kind === "pull_request" ? { parent_pr: parentRef } : {}),
        ...(parsed.parent_kind === "discussion" ? { parent_discussion: parentRef } : {}),
        ...(parsed.parent_comment_node_id !== null ? { parent_comment: parentCommentRef } : {}),
        ...(parsed.author !== null ? { author: authorRef } : {}),
        body: parsed.body,
        updated_at: parsed.updated_at,
        content_hash: parsed.content_hash,
      },
    );
  }
}

export async function tombstoneMissingComments(
  db: Surreal,
  parentNodeId: string,
  parentKind: "issue" | "pull_request" | "discussion",
  remoteCommentNodeIds: string[],
): Promise<{ tombstoned: number }> {
  const parentTable = parentKind === "pull_request" ? "pull_request" : parentKind;
  const parentField =
    parentKind === "pull_request"
      ? "parent_pr"
      : parentKind === "issue"
        ? "parent_issue"
        : "parent_discussion";

  const [parentRows] = await db.query<[Array<{ id: unknown }>]>(
    `SELECT id FROM ${parentTable} WHERE github_node_id = $node_id`,
    { node_id: parentNodeId },
  );
  if (parentRows.length === 0) return { tombstoned: 0 };

  const parentRef = new StringRecordId(String(parentRows[0].id));

  const [localComments] = await db.query<[Array<{ id: unknown; github_node_id: string }>]>(
    `SELECT id, github_node_id FROM comment WHERE ${parentField} = $parentRef AND deleted_at IS NONE`,
    { parentRef },
  );

  const remoteSet = new Set(remoteCommentNodeIds);
  const toTombstone = localComments.filter((c) => !remoteSet.has(c.github_node_id));

  for (const comment of toTombstone) {
    await db.query("UPDATE $id SET deleted_at = time::now()", {
      id: new StringRecordId(String(comment.id)),
    });
  }

  return { tombstoned: toTombstone.length };
}
