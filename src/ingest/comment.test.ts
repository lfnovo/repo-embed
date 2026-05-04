import { describe, it, expect, mock } from "bun:test";
import { StringRecordId } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";

import issueFixture from "./__fixtures__/comments_issue_page_1.json";
import discussionFixture from "./__fixtures__/comments_discussion_page_1.json";

let currentFixture: unknown = issueFixture;

mock.module("../clients/github.ts", () => ({
  paginate: async function* (
    _query: string,
    _variables: unknown,
    selectConnection: (data: unknown) => {
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    },
  ) {
    const connection = selectConnection(currentFixture);
    for (const node of connection.nodes) {
      yield node;
    }
  },
  gh: async () => ({}),
}));

const {
  persistComment,
  tombstoneMissingComments,
  hashBody,
  fetchCommentsForIssue,
  fetchCommentsForDiscussion,
} = await import("./comment.ts");
type ParsedComment = Parameters<typeof persistComment>[1];

// ─── shared setup helpers ─────────────────────────────────────────────────────

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function setupRepo(db: Db, suffix: string): Promise<string> {
  const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE org CONTENT {
      github_node_id: $nid,
      github_url: $url,
      login: $login,
      name: $name,
      kind: "User",
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    {
      nid: `ORG_${suffix}`,
      url: `https://github.com/org${suffix}`,
      login: `org${suffix}`,
      name: `Org ${suffix}`,
    },
  );
  const orgId = orgRows[0].id;

  const [repoRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE repo CONTENT {
      github_node_id: $nid,
      github_url: $url,
      name: "repo",
      name_with_owner: $nwo,
      description: NONE,
      is_private: false,
      owner: $orgId,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    {
      nid: `REPO_${suffix}`,
      url: `https://github.com/org${suffix}/repo`,
      nwo: `org${suffix}/repo`,
      orgId,
    },
  );
  return String(repoRows[0].id);
}

async function setupIssue(db: Db, repoId: string, nodeId: string): Promise<string> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE issue CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/issues/1",
      repo: $repo,
      number: 1,
      title: "Test Issue",
      body: NONE,
      state: "OPEN",
      state_reason: NONE,
      author: NONE,
      closed_at: NONE,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE,
      content_hash: NONE,
      embedding: NONE
    }`,
    { nid: nodeId, repo: new StringRecordId(repoId) },
  );
  return String(rows[0].id);
}

async function setupPR(db: Db, repoId: string, nodeId: string): Promise<string> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE pull_request CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/pull/1",
      repo: $repo,
      number: 1,
      title: "Test PR",
      body: NONE,
      state: "OPEN",
      author: NONE,
      merged_at: NONE,
      closed_at: NONE,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE,
      content_hash: NONE,
      embedding: NONE
    }`,
    { nid: nodeId, repo: new StringRecordId(repoId) },
  );
  return String(rows[0].id);
}

async function setupDiscussion(db: Db, repoId: string, nodeId: string): Promise<string> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE discussion CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/discussions/1",
      repo: $repo,
      number: 1,
      title: "Test Discussion",
      body: NONE,
      category: NONE,
      author: NONE,
      answer_chosen_at: NONE,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE,
      content_hash: NONE,
      embedding: NONE
    }`,
    { nid: nodeId, repo: new StringRecordId(repoId) },
  );
  return String(rows[0].id);
}

function makeComment(
  overrides: Partial<ParsedComment> & {
    parent_kind: ParsedComment["parent_kind"];
    parent_node_id: string;
  },
): ParsedComment {
  return {
    github_node_id: "C_TEST_001",
    github_url: "https://github.com/test/repo/issues/1#issuecomment-1",
    body: "Test comment body",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    content_hash: hashBody("Test comment body"),
    author: {
      github_node_id: "U_TEST_001",
      login: "commenter",
      is_bot: false,
      github_url: "https://github.com/commenter",
    },
    parent_comment_node_id: null,
    ...overrides,
  };
}

// ─── 1. persistComment for issue parent ──────────────────────────────────────

describe("persistComment for issue parent", () => {
  it("sets parent_issue, and parent_pr/parent_discussion are NONE", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "CA");
      await setupIssue(db, repoId, "I_CA_001");

      const comment = makeComment({ parent_kind: "issue", parent_node_id: "I_CA_001" });
      await persistComment(db, comment);

      const [rows] = await db.query<
        [Array<{ pi_none: boolean; ppr_none: boolean; pd_none: boolean }>]
      >(
        `SELECT
          parent_issue IS NONE AS pi_none,
          parent_pr IS NONE AS ppr_none,
          parent_discussion IS NONE AS pd_none
        FROM comment WHERE github_node_id = $id`,
        { id: comment.github_node_id },
      );
      expect(rows.length).toBe(1);
      expect(rows[0].pi_none).toBe(false);
      expect(rows[0].ppr_none).toBe(true);
      expect(rows[0].pd_none).toBe(true);
    });
  });
});

// ─── 2. persistComment for PR parent ─────────────────────────────────────────

describe("persistComment for PR parent", () => {
  it("sets parent_pr, and parent_issue/parent_discussion are NONE", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "CB");
      await setupPR(db, repoId, "PR_CB_001");

      const comment = makeComment({
        github_node_id: "C_CB_001",
        parent_kind: "pull_request",
        parent_node_id: "PR_CB_001",
      });
      await persistComment(db, comment);

      const [rows] = await db.query<
        [Array<{ pi_none: boolean; ppr_none: boolean; pd_none: boolean }>]
      >(
        `SELECT
          parent_issue IS NONE AS pi_none,
          parent_pr IS NONE AS ppr_none,
          parent_discussion IS NONE AS pd_none
        FROM comment WHERE github_node_id = $id`,
        { id: comment.github_node_id },
      );
      expect(rows.length).toBe(1);
      expect(rows[0].pi_none).toBe(true);
      expect(rows[0].ppr_none).toBe(false);
      expect(rows[0].pd_none).toBe(true);
    });
  });
});

// ─── 3. persistComment for discussion parent ──────────────────────────────────

describe("persistComment for discussion parent", () => {
  it("sets parent_discussion, and parent_issue/parent_pr are NONE", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "CC");
      await setupDiscussion(db, repoId, "D_CC_001");

      const comment = makeComment({
        github_node_id: "C_CC_001",
        parent_kind: "discussion",
        parent_node_id: "D_CC_001",
      });
      await persistComment(db, comment);

      const [rows] = await db.query<
        [Array<{ pi_none: boolean; ppr_none: boolean; pd_none: boolean }>]
      >(
        `SELECT
          parent_issue IS NONE AS pi_none,
          parent_pr IS NONE AS ppr_none,
          parent_discussion IS NONE AS pd_none
        FROM comment WHERE github_node_id = $id`,
        { id: comment.github_node_id },
      );
      expect(rows.length).toBe(1);
      expect(rows[0].pi_none).toBe(true);
      expect(rows[0].ppr_none).toBe(true);
      expect(rows[0].pd_none).toBe(false);
    });
  });
});

// ─── 4. persistComment idempotency ────────────────────────────────────────────

describe("persistComment idempotency", () => {
  it("persisting same comment twice leaves exactly 1 comment row and 1 user row", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "CD");
      await setupIssue(db, repoId, "I_CD_001");

      const comment = makeComment({ parent_kind: "issue", parent_node_id: "I_CD_001" });
      await persistComment(db, comment);
      await persistComment(db, comment);

      const [commentRows] = await db.query<[Array<unknown>]>("SELECT id FROM comment");
      expect(commentRows.length).toBe(1);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(1);
    });
  });
});

// ─── 5. persistComment author: null ──────────────────────────────────────────

describe("persistComment author: null", () => {
  it("stores author as NONE and creates no user rows", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "CE");
      await setupIssue(db, repoId, "I_CE_001");

      const comment = makeComment({
        github_node_id: "C_CE_001",
        parent_kind: "issue",
        parent_node_id: "I_CE_001",
        author: null,
      });
      await persistComment(db, comment);

      const [rows] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT author IS NONE AS is_none FROM comment WHERE github_node_id = $id",
        { id: comment.github_node_id },
      );
      expect(rows.length).toBe(1);
      expect(rows[0].is_none).toBe(true);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(0);
    });
  });
});

// ─── 6. persistComment parent not found ──────────────────────────────────────

describe("persistComment parent not found", () => {
  it("throws an error matching 'parent not found' when parent does not exist", async () => {
    await withTestDb(async (db) => {
      const comment = makeComment({
        parent_kind: "issue",
        parent_node_id: "I_NONEXISTENT",
      });

      await expect(persistComment(db, comment)).rejects.toThrow("parent not found");
    });
  });
});

// ─── 7. persistComment discussion reply ──────────────────────────────────────

describe("persistComment discussion reply", () => {
  it("reply's parent_comment field points to the top-level comment", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "CF");
      await setupDiscussion(db, repoId, "D_CF_001");

      const topComment = makeComment({
        github_node_id: "C_CF_TOP",
        parent_kind: "discussion",
        parent_node_id: "D_CF_001",
      });
      await persistComment(db, topComment);

      const reply = makeComment({
        github_node_id: "C_CF_REPLY",
        parent_kind: "discussion",
        parent_node_id: "D_CF_001",
        parent_comment_node_id: "C_CF_TOP",
      });
      await persistComment(db, reply);

      const [rows] = await db.query<[Array<{ pc_none: boolean }>]>(
        "SELECT parent_comment IS NONE AS pc_none FROM comment WHERE github_node_id = $id",
        { id: reply.github_node_id },
      );
      expect(rows.length).toBe(1);
      expect(rows[0].pc_none).toBe(false);
    });
  });
});

// ─── 8. tombstoneMissingComments ─────────────────────────────────────────────

describe("tombstoneMissingComments", () => {
  it("marks absent comment with deleted_at and returns { tombstoned: 1 }", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "CG");
      await setupIssue(db, repoId, "I_CG_001");

      const c1 = makeComment({
        github_node_id: "C_CG_001",
        parent_kind: "issue",
        parent_node_id: "I_CG_001",
        author: null,
      });
      const c2 = makeComment({
        github_node_id: "C_CG_002",
        parent_kind: "issue",
        parent_node_id: "I_CG_001",
        author: null,
      });
      await persistComment(db, c1);
      await persistComment(db, c2);

      const result = await tombstoneMissingComments(db, "I_CG_001", "issue", ["C_CG_001"]);
      expect(result).toEqual({ tombstoned: 1 });

      const [kept] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM comment WHERE github_node_id = $id",
        { id: "C_CG_001" },
      );
      expect(kept[0].is_none).toBe(true);

      const [gone] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM comment WHERE github_node_id = $id",
        { id: "C_CG_002" },
      );
      expect(gone[0].is_none).toBe(false);
    });
  });
});

// ─── 9. fetchCommentsForIssue mock ───────────────────────────────────────────

describe("fetchCommentsForIssue mock", () => {
  it("yields 2 comments with correct shape from fixture", async () => {
    currentFixture = issueFixture;

    const comments: ParsedComment[] = [];
    for await (const c of fetchCommentsForIssue("test", "repo", 1)) {
      comments.push(c);
    }

    expect(comments.length).toBe(2);

    for (const c of comments) {
      expect(c.parent_kind).toBe("issue");
      expect(c.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.parent_comment_node_id).toBeNull();
    }

    const c1 = comments.find((c) => c.github_node_id === "IC_001")!;
    expect(c1).toBeDefined();
    expect(c1.author).not.toBeNull();
    expect(c1.author?.login).toBe("testuser");
    expect(c1.body).not.toContain("\r\n");

    const c2 = comments.find((c) => c.github_node_id === "IC_002")!;
    expect(c2).toBeDefined();
    expect(c2.author).toBeNull();
  });
});

// ─── 10. fetchCommentsForDiscussion mock ─────────────────────────────────────

describe("fetchCommentsForDiscussion mock", () => {
  it("yields top-level comment and reply; reply has parent_comment_node_id set", async () => {
    currentFixture = discussionFixture;

    const comments: ParsedComment[] = [];
    for await (const c of fetchCommentsForDiscussion("test", "repo", 1)) {
      comments.push(c);
    }

    expect(comments.length).toBe(2);

    const top = comments.find((c) => c.github_node_id === "DC_001")!;
    expect(top).toBeDefined();
    expect(top.parent_kind).toBe("discussion");
    expect(top.parent_comment_node_id).toBeNull();

    const reply = comments.find((c) => c.github_node_id === "DC_REPLY_001")!;
    expect(reply).toBeDefined();
    expect(reply.parent_kind).toBe("discussion");
    expect(reply.parent_comment_node_id).toBe("DC_001");
    expect(reply.author?.login).toBe("replyuser");
  });
});
