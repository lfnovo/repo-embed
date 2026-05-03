import { describe, it, expect } from "bun:test";
import { extractReferences, linkClosingIssues } from "./crossrefs.ts";
import { withTestDb } from "../test_utils/with_test_db.ts";

describe("extractReferences", () => {
  it("extracts a same-repo #N mention", () => {
    expect(extractReferences("See #5")).toEqual([
      { owner: null, repo: null, number: 5, isClosing: false },
    ]);
  });

  it("extracts a cross-repo owner/repo#N mention", () => {
    expect(extractReferences("See other/project#12")).toEqual([
      { owner: "other", repo: "project", number: 12, isClosing: false },
    ]);
  });

  it("sets isClosing for Fixes keyword", () => {
    expect(extractReferences("Fixes #3")).toEqual([
      { owner: null, repo: null, number: 3, isClosing: true },
    ]);
  });

  it("sets isClosing for Closes keyword", () => {
    expect(extractReferences("Closes #3")).toEqual([
      { owner: null, repo: null, number: 3, isClosing: true },
    ]);
  });

  it("sets isClosing for Resolves keyword", () => {
    expect(extractReferences("Resolves #3")).toEqual([
      { owner: null, repo: null, number: 3, isClosing: true },
    ]);
  });

  it("skips references inside fenced code blocks", () => {
    expect(extractReferences("```\n#4\n```")).toEqual([]);
  });

  it("skips references inside URLs", () => {
    expect(extractReferences("https://github.com/foo/bar#1")).toEqual([]);
  });

  it("skips self-references", () => {
    expect(
      extractReferences("#42", { owner: "a", name: "b", number: 42 })
    ).toEqual([]);
  });

  it("deduplicates repeated same-repo references", () => {
    expect(extractReferences("#5 and #5 again")).toEqual([
      { owner: null, repo: null, number: 5, isClosing: false },
    ]);
  });
});

// ─── linkClosingIssues ────────────────────────────────────────────────────────

async function setupXrDb(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
): Promise<{ prId: string; issueNodeId: string }> {
  const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE org CONTENT {
      github_node_id: "ORG_XR",
      github_url: "https://github.com/testorg",
      login: "testorgxr",
      name: "Test Org",
      kind: "User",
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    {},
  );
  const orgId = orgRows[0].id;

  const [repoRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE repo CONTENT {
      github_node_id: "REPO_XR",
      github_url: "https://github.com/testorg/repo",
      name: "repo",
      name_with_owner: "testorgxr/repo",
      description: NONE,
      is_private: false,
      owner: $orgId,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    { orgId },
  );
  const repoId = repoRows[0].id;

  const [issueRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE issue CONTENT {
      github_node_id: "ISSUE_XR_1",
      github_url: "https://github.com/testorg/repo/issues/1",
      repo: $repoId,
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
    { repoId },
  );

  const [prRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE pull_request CONTENT {
      github_node_id: "PR_XR_1",
      github_url: "https://github.com/testorg/repo/pull/101",
      repo: $repoId,
      number: 101,
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
    { repoId },
  );

  return {
    prId: String(prRows[0].id),
    issueNodeId: String(issueRows[0].id).split(":")[1] ? "ISSUE_XR_1" : "ISSUE_XR_1",
  };
}

describe("linkClosingIssues", () => {
  it("idempotency: calling twice creates exactly 1 closes edge", async () => {
    await withTestDb(async (db) => {
      const { prId } = await setupXrDb(db);
      await linkClosingIssues(db, prId, ["ISSUE_XR_1"]);
      await linkClosingIssues(db, prId, ["ISSUE_XR_1"]);

      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM closes");
      expect(edges.length).toBe(1);
    });
  });

  it("no-op for unknown issue: creates 0 closes edges and throws no error", async () => {
    await withTestDb(async (db) => {
      const { prId } = await setupXrDb(db);
      await expect(linkClosingIssues(db, prId, ["NONEXISTENT_NODE"])).resolves.toBeUndefined();

      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM closes");
      expect(edges.length).toBe(0);
    });
  });
});
