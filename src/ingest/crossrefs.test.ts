import { describe, it, expect } from "bun:test";
import { StringRecordId } from "surrealdb";
import { extractReferences, linkClosingIssues, extractAndLinkCrossRefs, materializeDanglingReferences } from "./crossrefs.ts";
import { withTestDb } from "../test_utils/with_test_db.ts";
import type { RepoRef } from "./types.ts";

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

// ─── Cross-reference test setup ──────────────────────────────────────────────

type CrossRefDb = {
  mainRepo: RepoRef;
  otherRepo: RepoRef;
  issue1Id: string;
  pr101Id: string;
  disc200Id: string;
  otherIssue5Id: string;
};

async function setupCrossRefDb(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
): Promise<CrossRefDb> {
  const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE org CONTENT {
      github_node_id: "ORG_CR",
      github_url: "https://github.com/testorg",
      login: "testorg",
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
      github_node_id: "REPO_CR_MAIN",
      github_url: "https://github.com/testorg/repo",
      name: "repo",
      name_with_owner: "testorg/repo",
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
  const mainRepo: RepoRef = { id: String(repoId), name_with_owner: "testorg/repo" };

  const [otherRepoRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE repo CONTENT {
      github_node_id: "REPO_CR_OTHER",
      github_url: "https://github.com/other/project",
      name: "project",
      name_with_owner: "other/project",
      description: NONE,
      is_private: false,
      owner: $orgId,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    { orgId },
  );
  const otherRepoId = otherRepoRows[0].id;
  const otherRepo: RepoRef = { id: String(otherRepoId), name_with_owner: "other/project" };

  const [issue1Rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE issue CONTENT {
      github_node_id: "ISSUE_CR_1",
      github_url: "https://github.com/testorg/repo/issues/1",
      repo: $repoId,
      number: 1,
      title: "Issue 1",
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

  const [pr101Rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE pull_request CONTENT {
      github_node_id: "PR_CR_101",
      github_url: "https://github.com/testorg/repo/pull/101",
      repo: $repoId,
      number: 101,
      title: "PR 101",
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

  const [disc200Rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE discussion CONTENT {
      github_node_id: "DISC_CR_200",
      github_url: "https://github.com/testorg/repo/discussions/200",
      repo: $repoId,
      number: 200,
      title: "Discussion 200",
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
    { repoId },
  );

  const [otherIssue5Rows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE issue CONTENT {
      github_node_id: "ISSUE_CR_OTHER_5",
      github_url: "https://github.com/other/project/issues/5",
      repo: $otherRepoId,
      number: 5,
      title: "Other Issue 5",
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
    { otherRepoId },
  );

  return {
    mainRepo,
    otherRepo,
    issue1Id: String(issue1Rows[0].id),
    pr101Id: String(pr101Rows[0].id),
    disc200Id: String(disc200Rows[0].id),
    otherIssue5Id: String(otherIssue5Rows[0].id),
  };
}

// ─── extractAndLinkCrossRefs ──────────────────────────────────────────────────

describe("extractAndLinkCrossRefs", () => {
  it("same-repo #1 in PR #101 body creates a references_ref edge", async () => {
    await withTestDb(async (db) => {
      const { mainRepo, pr101Id } = await setupCrossRefDb(db);
      await db.query("UPDATE $id SET body = 'See #1'", { id: new StringRecordId(pr101Id) });

      const result = await extractAndLinkCrossRefs(db, mainRepo);

      expect(result.same_repo_refs).toBe(1);
      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edges.length).toBe(1);
    });
  });

  it("same-repo #999 (non-existent) in PR body creates no edge and no dangling row", async () => {
    await withTestDb(async (db) => {
      const { mainRepo, pr101Id } = await setupCrossRefDb(db);
      await db.query("UPDATE $id SET body = 'See #999'", { id: new StringRecordId(pr101Id) });

      const result = await extractAndLinkCrossRefs(db, mainRepo);

      expect(result.same_repo_refs).toBe(0);
      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edges.length).toBe(0);
      const [dangling] = await db.query<[Array<unknown>]>("SELECT id FROM dangling_reference");
      expect(dangling.length).toBe(0);
    });
  });

  it("cross-repo other/project#5 in PR body, other/project mirrored → references_ref edge", async () => {
    await withTestDb(async (db) => {
      const { mainRepo, pr101Id } = await setupCrossRefDb(db);
      await db.query("UPDATE $id SET body = 'See other/project#5'", { id: new StringRecordId(pr101Id) });

      const result = await extractAndLinkCrossRefs(db, mainRepo);

      expect(result.cross_repo_refs_resolved).toBe(1);
      expect(result.cross_repo_refs_dangling).toBe(0);
      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edges.length).toBe(1);
    });
  });

  it("cross-repo nobody/norepo#7 in PR body, not mirrored → dangling_reference row", async () => {
    await withTestDb(async (db) => {
      const { mainRepo, pr101Id } = await setupCrossRefDb(db);
      await db.query("UPDATE $id SET body = 'See nobody/norepo#7'", { id: new StringRecordId(pr101Id) });

      const result = await extractAndLinkCrossRefs(db, mainRepo);

      expect(result.cross_repo_refs_dangling).toBe(1);
      expect(result.cross_repo_refs_resolved).toBe(0);
      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edges.length).toBe(0);
      const [dangling] = await db.query<[Array<{ target_owner: string; target_repo: string; target_number: number; ref_kind: string }>]>(
        "SELECT target_owner, target_repo, target_number, ref_kind FROM dangling_reference",
      );
      expect(dangling.length).toBe(1);
      expect(dangling[0].target_owner).toBe("nobody");
      expect(dangling[0].target_repo).toBe("norepo");
      expect(dangling[0].target_number).toBe(7);
      expect(dangling[0].ref_kind).toBe("references_ref");
    });
  });

  it("replace-all: second run with different body removes stale edges", async () => {
    await withTestDb(async (db) => {
      const { mainRepo, pr101Id } = await setupCrossRefDb(db);

      // First run: body references #1 → creates 1 edge
      await db.query("UPDATE $id SET body = 'See #1'", { id: new StringRecordId(pr101Id) });
      await extractAndLinkCrossRefs(db, mainRepo);
      const [edgesAfterFirst] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edgesAfterFirst.length).toBe(1);

      // Second run: body references #999 (no target) → old edge removed, 0 edges remain
      await db.query("UPDATE $id SET body = 'See #999'", { id: new StringRecordId(pr101Id) });
      await extractAndLinkCrossRefs(db, mainRepo);
      const [edgesAfterSecond] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edgesAfterSecond.length).toBe(0);
    });
  });
});

// ─── materializeDanglingReferences ───────────────────────────────────────────

describe("materializeDanglingReferences", () => {
  it("converts a dangling_reference row to a references_ref edge and deletes the row", async () => {
    await withTestDb(async (db) => {
      const { mainRepo: _mainRepo, otherRepo, pr101Id } = await setupCrossRefDb(db);

      // Manually insert a dangling_reference pointing at other/project#5
      await db.query(
        `CREATE dangling_reference CONTENT {
          parent: $parentRef,
          target_owner: 'other',
          target_repo: 'project',
          target_number: 5,
          ref_kind: 'references_ref',
          detected_at: time::now()
        }`,
        { parentRef: new StringRecordId(pr101Id) },
      );

      const result = await materializeDanglingReferences(db, otherRepo);

      expect(result.materialized).toBe(1);
      const [dangling] = await db.query<[Array<unknown>]>("SELECT id FROM dangling_reference");
      expect(dangling.length).toBe(0);
      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edges.length).toBe(1);
    });
  });

  it("returns { materialized: 0 } when there are no matching dangling rows", async () => {
    await withTestDb(async (db) => {
      const { otherRepo } = await setupCrossRefDb(db);

      const result = await materializeDanglingReferences(db, otherRepo);

      expect(result.materialized).toBe(0);
      const [edges] = await db.query<[Array<unknown>]>("SELECT id FROM references_ref");
      expect(edges.length).toBe(0);
    });
  });
});
