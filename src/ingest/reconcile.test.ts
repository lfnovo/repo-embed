import { describe, it, expect } from "bun:test";
import { StringRecordId } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";
import { reconcileTopLevel } from "./reconcile.ts";

// ─── mock gh factory ─────────────────────────────────────────────────────────

type GhFn = <T>(query: string, params?: Record<string, unknown>) => Promise<T>;

function makeMockGh(issueIds: string[], prIds: string[], discIds: string[]): GhFn {
  return async <T>(query: string, _params?: Record<string, unknown>): Promise<T> => {
    if (query.includes("FetchIssueIds")) {
      return {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: issueIds.map((id) => ({ id })),
          },
        },
      } as T;
    }
    if (query.includes("FetchPrIds")) {
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: prIds.map((id) => ({ id })),
          },
        },
      } as T;
    }
    if (query.includes("FetchDiscussionIds")) {
      return {
        repository: {
          discussions: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: discIds.map((id) => ({ id })),
          },
        },
      } as T;
    }
    throw new Error(`Unexpected query in mock: ${query.slice(0, 60)}`);
  };
}

// ─── DB seed helpers ──────────────────────────────────────────────────────────

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

async function setupIssue(db: Db, repoId: string, nodeId: string, number: number): Promise<string> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE issue CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/issues/" + <string>$num,
      repo: $repo,
      number: $num,
      title: $nid,
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
    { nid: nodeId, num: number, repo: new StringRecordId(repoId) },
  );
  return String(rows[0].id);
}

async function setupPR(db: Db, repoId: string, nodeId: string, number: number): Promise<string> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE pull_request CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/pull/" + <string>$num,
      repo: $repo,
      number: $num,
      title: $nid,
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
    { nid: nodeId, num: number, repo: new StringRecordId(repoId) },
  );
  return String(rows[0].id);
}

async function setupDiscussion(db: Db, repoId: string, nodeId: string, number: number): Promise<string> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE discussion CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/discussions/" + <string>$num,
      repo: $repo,
      number: $num,
      title: $nid,
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
    { nid: nodeId, num: number, repo: new StringRecordId(repoId) },
  );
  return String(rows[0].id);
}

async function setupComment(db: Db, issueId: string, nodeId: string): Promise<string> {
  const [rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE comment CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/issues/1#issuecomment-1",
      parent_issue: $issueId,
      parent_pr: NONE,
      parent_discussion: NONE,
      parent_comment: NONE,
      author: NONE,
      body: "test comment",
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE,
      content_hash: NONE,
      embedding: NONE
    }`,
    { nid: nodeId, issueId: new StringRecordId(issueId) },
  );
  return String(rows[0].id);
}

// ─── 1. Happy path ────────────────────────────────────────────────────────────

describe("reconcileTopLevel — happy path", () => {
  it("tombstones missing issue and PR; leaves present items and discussion untouched", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "RA");
      const repo = { id: repoId, name_with_owner: "orgRA/repo" };

      await setupIssue(db, repoId, "I_001", 1);
      await setupIssue(db, repoId, "I_002", 2);
      await setupIssue(db, repoId, "I_003", 3);
      await setupPR(db, repoId, "PR_001", 1);
      await setupPR(db, repoId, "PR_002", 2);
      await setupDiscussion(db, repoId, "D_001", 1);

      // GitHub returns I_001, I_002 (missing I_003); PR_001 (missing PR_002); D_001
      const mockGh = makeMockGh(["I_001", "I_002"], ["PR_001"], ["D_001"]);

      const result = await reconcileTopLevel(db, repo, "orgRA", "repo", mockGh);

      expect(result).toEqual({ issues_tombstoned: 1, prs_tombstoned: 1, discussions_tombstoned: 0 });

      // I_003 should be tombstoned
      const [i3] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM issue WHERE github_node_id = $id",
        { id: "I_003" },
      );
      expect(i3[0].is_none).toBe(false);

      // I_001 and I_002 should NOT be tombstoned
      const [i1] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM issue WHERE github_node_id = $id",
        { id: "I_001" },
      );
      expect(i1[0].is_none).toBe(true);

      // PR_002 should be tombstoned
      const [pr2] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM pull_request WHERE github_node_id = $id",
        { id: "PR_002" },
      );
      expect(pr2[0].is_none).toBe(false);

      // PR_001 should NOT be tombstoned
      const [pr1] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM pull_request WHERE github_node_id = $id",
        { id: "PR_001" },
      );
      expect(pr1[0].is_none).toBe(true);

      // D_001 should NOT be tombstoned
      const [d1] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM discussion WHERE github_node_id = $id",
        { id: "D_001" },
      );
      expect(d1[0].is_none).toBe(true);
    });
  });
});

// ─── 2. Idempotency ───────────────────────────────────────────────────────────

describe("reconcileTopLevel — idempotency", () => {
  it("re-run returns 0 tombstoned and does not update deleted_at timestamp", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "RB");
      const repo = { id: repoId, name_with_owner: "orgRB/repo" };

      await setupIssue(db, repoId, "I_001", 1);
      await setupIssue(db, repoId, "I_002", 2);
      await setupIssue(db, repoId, "I_003", 3);
      await setupPR(db, repoId, "PR_001", 1);
      await setupPR(db, repoId, "PR_002", 2);
      await setupDiscussion(db, repoId, "D_001", 1);

      const mockGh = makeMockGh(["I_001", "I_002"], ["PR_001"], ["D_001"]);

      // First run — tombstones I_003 and PR_002
      await reconcileTopLevel(db, repo, "orgRB", "repo", mockGh);

      const [afterFirst] = await db.query<[Array<{ deleted_at: unknown }>]>(
        "SELECT deleted_at FROM issue WHERE github_node_id = $id",
        { id: "I_003" },
      );
      const firstDeletedAt = afterFirst[0].deleted_at;
      expect(firstDeletedAt).not.toBeNull();
      expect(firstDeletedAt).not.toBeUndefined();

      // Second run — I_003 and PR_002 are now excluded by `deleted_at IS NONE`
      const result = await reconcileTopLevel(db, repo, "orgRB", "repo", mockGh);
      expect(result).toEqual({ issues_tombstoned: 0, prs_tombstoned: 0, discussions_tombstoned: 0 });

      // deleted_at on I_003 must not have changed
      const [afterSecond] = await db.query<[Array<{ deleted_at: unknown }>]>(
        "SELECT deleted_at FROM issue WHERE github_node_id = $id",
        { id: "I_003" },
      );
      expect(String(afterSecond[0].deleted_at)).toBe(String(firstDeletedAt));
    });
  });
});

// ─── 3. Passive cascade ───────────────────────────────────────────────────────

describe("reconcileTopLevel — passive cascade", () => {
  it("comments under a tombstoned issue retain deleted_at = NONE", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "RC");
      const repo = { id: repoId, name_with_owner: "orgRC/repo" };

      // I_003 is the one that will be tombstoned; it has a comment
      const issue3Id = await setupIssue(db, repoId, "I_003", 3);
      await setupComment(db, issue3Id, "C_001");

      await setupIssue(db, repoId, "I_001", 1);
      await setupIssue(db, repoId, "I_002", 2);
      await setupPR(db, repoId, "PR_001", 1);
      await setupPR(db, repoId, "PR_002", 2);
      await setupDiscussion(db, repoId, "D_001", 1);

      const mockGh = makeMockGh(["I_001", "I_002"], ["PR_001"], ["D_001"]);
      await reconcileTopLevel(db, repo, "orgRC", "repo", mockGh);

      // Verify I_003 is tombstoned
      const [i3] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM issue WHERE github_node_id = $id",
        { id: "I_003" },
      );
      expect(i3[0].is_none).toBe(false);

      // Verify comment C_001 still has deleted_at IS NONE (passive cascade)
      const [c1] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT deleted_at IS NONE AS is_none FROM comment WHERE github_node_id = $id",
        { id: "C_001" },
      );
      expect(c1[0].is_none).toBe(true);
    });
  });
});
