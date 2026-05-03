import { describe, it, expect, mock } from "bun:test";
import { withTestDb } from "../test_utils/with_test_db.ts";

import page1 from "./__fixtures__/pull_requests_page_1.json";
import page2 from "./__fixtures__/pull_requests_page_2.json";

mock.module("../clients/github.ts", () => ({
  paginate: async function* (
    _query: string,
    _variables: unknown,
    selectConnection: (data: unknown) => {
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    },
  ) {
    for (const page of [page1, page2]) {
      const connection = selectConnection(page);
      for (const node of connection.nodes) {
        yield node;
      }
    }
  },
  gh: async () => ({
    repository: {
      pullRequest: {
        commits: {
          nodes: [
            {
              commit: {
                id: "C_PR1_101",
                url: "https://github.com/test/repo/commit/abc101",
                oid: "abc101",
                messageHeadline: "Commit 101",
                messageBody: null,
                committedDate: "2026-01-02T00:00:00Z",
                author: { user: null },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }),
}));

const { fetchPullRequests, persistPullRequest } = await import("./pull_request.ts");
type ParsedPullRequest = Parameters<typeof persistPullRequest>[2];

// ─── shared repo setup ────────────────────────────────────────────────────────

async function setupRepo(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  suffix: string,
): Promise<string> {
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
      url: `https://github.com/testorg${suffix}`,
      login: `testorg${suffix}`,
      name: `Test Org ${suffix}`,
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
      url: `https://github.com/testorg${suffix}/repo`,
      nwo: `testorg${suffix}/repo`,
      orgId,
    },
  );
  return String(repoRows[0].id);
}

// ─── 1. fetchPullRequests — 2-page yield ─────────────────────────────────────

describe("fetchPullRequests 2-page yield", () => {
  it("collects 3 PRs; PR_001 has 3 commits (2 inline + 1 from secondary gh() call)", async () => {
    const prs: ParsedPullRequest[] = [];
    for await (const pr of fetchPullRequests("test", "repo")) {
      prs.push(pr);
    }

    expect(prs.length).toBe(3);

    const ids = prs.map((p) => p.github_node_id);
    expect(ids).toContain("PR_001");
    expect(ids).toContain("PR_002");
    expect(ids).toContain("PR_003");

    const pr1 = prs.find((p) => p.github_node_id === "PR_001")!;
    expect(pr1.commits.length).toBe(3);
  });
});

// ─── 2. fetchPullRequests — MERGED PR shape ──────────────────────────────────

describe("fetchPullRequests MERGED PR shape", () => {
  it("PR_002 has state MERGED, merged_at as Date, closing_issue_node_ids contains I_001", async () => {
    const prs: ParsedPullRequest[] = [];
    for await (const pr of fetchPullRequests("test", "repo")) {
      prs.push(pr);
    }

    const pr2 = prs.find((p) => p.github_node_id === "PR_002")!;
    expect(pr2.state).toBe("MERGED");
    expect(pr2.merged_at).toBeInstanceOf(Date);
    expect(pr2.closing_issue_node_ids).toContain("I_001");
  });
});

// ─── 3. fetchPullRequests — ghost commit author ───────────────────────────────

describe("fetchPullRequests ghost commit author", () => {
  it("PR_003's single commit has author === null", async () => {
    const prs: ParsedPullRequest[] = [];
    for await (const pr of fetchPullRequests("test", "repo")) {
      prs.push(pr);
    }

    const pr3 = prs.find((p) => p.github_node_id === "PR_003")!;
    expect(pr3.commits.length).toBe(1);
    expect(pr3.commits[0].author).toBeNull();
  });
});

// ─── 4. persistPullRequest idempotency ───────────────────────────────────────

describe("persistPullRequest idempotency", () => {
  it("calling twice leaves exactly 1 pr, 1 user, 1 commit, 1 contains_commit, 1 has_label", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "PRIDEM");
      const repo = { id: repoId, name_with_owner: "testorgPRIDEM/repo" };

      const parsed: ParsedPullRequest = {
        github_node_id: "PR_IDEM_1",
        github_url: "https://github.com/testorgPRIDEM/repo/pull/10",
        number: 10,
        title: "Idempotency Test PR",
        body: "Some body",
        state: "OPEN",
        closed_at: null,
        merged_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1",
        author: {
          github_node_id: "U_PR_IDEM_1",
          login: "testuser",
          is_bot: false,
          github_url: "https://github.com/testuser",
        },
        labels: [
          { github_node_id: "LB_PR_IDEM_1", name: "bug", color: "d73a4a", description: null },
        ],
        commits: [
          {
            github_node_id: "C_IDEM_1",
            oid: "abc001idem",
            github_url: "https://github.com/testorgPRIDEM/repo/commit/abc001idem",
            message_headline: "First commit",
            message_body: null,
            committed_date: new Date("2026-01-01T10:00:00Z"),
            author: null,
          },
        ],
        closing_issue_node_ids: [],
      };

      await persistPullRequest(db, repo, parsed);
      await persistPullRequest(db, repo, parsed);

      const [prRows] = await db.query<[Array<unknown>]>("SELECT id FROM pull_request");
      expect(prRows.length).toBe(1);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(1);

      const [commitRows] = await db.query<[Array<unknown>]>("SELECT id FROM commit");
      expect(commitRows.length).toBe(1);

      const [ccEdges] = await db.query<[Array<unknown>]>("SELECT id FROM contains_commit");
      expect(ccEdges.length).toBe(1);

      const [labelEdges] = await db.query<[Array<unknown>]>("SELECT id FROM has_label");
      expect(labelEdges.length).toBe(1);
    });
  });
});

// ─── 5. persistPullRequest null author ───────────────────────────────────────

describe("persistPullRequest null author", () => {
  it("stores author as NONE and creates no user rows", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "PRNULL");
      const repo = { id: repoId, name_with_owner: "testorgPRNULL/repo" };

      const parsed: ParsedPullRequest = {
        github_node_id: "PR_NULL_AUTH",
        github_url: "https://github.com/testorgPRNULL/repo/pull/5",
        number: 5,
        title: "No Author PR",
        body: "",
        state: "OPEN",
        closed_at: null,
        merged_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: "def456def456def456def456def456def456def456def456def456def456def4",
        author: null,
        labels: [],
        commits: [
          {
            github_node_id: "C_NULLAUTH_1",
            oid: "def001null",
            github_url: "https://github.com/testorgPRNULL/repo/commit/def001null",
            message_headline: "Some commit",
            message_body: null,
            committed_date: new Date("2026-01-01T10:00:00Z"),
            author: null,
          },
        ],
        closing_issue_node_ids: [],
      };

      await persistPullRequest(db, repo, parsed);

      const [isNoneRows] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT author IS NONE AS is_none FROM pull_request WHERE github_node_id = $id",
        { id: "PR_NULL_AUTH" },
      );
      expect(isNoneRows.length).toBe(1);
      expect(isNoneRows[0].is_none).toBe(true);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(0);
    });
  });
});

// ─── 6. persistPullRequest MERGED state ──────────────────────────────────────

describe("persistPullRequest MERGED state", () => {
  it("stores state as MERGED and sets merged_at", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "PRMERGED");
      const repo = { id: repoId, name_with_owner: "testorgPRMERGED/repo" };

      const parsed: ParsedPullRequest = {
        github_node_id: "PR_MERGED_1",
        github_url: "https://github.com/testorgPRMERGED/repo/pull/7",
        number: 7,
        title: "Merged PR",
        body: "This was merged",
        state: "MERGED",
        closed_at: new Date("2026-01-05T00:00:00Z"),
        merged_at: new Date("2026-01-05T00:00:00Z"),
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-05T00:00:00Z"),
        content_hash: "ghi789ghi789ghi789ghi789ghi789ghi789ghi789ghi789ghi789ghi789ghi7",
        author: null,
        labels: [],
        commits: [],
        closing_issue_node_ids: [],
      };

      await persistPullRequest(db, repo, parsed);

      const [prRows] = await db.query<[Array<{ state: string; merged_at_set: boolean }>]>(
        "SELECT state, merged_at IS NOT NONE AS merged_at_set FROM pull_request WHERE github_node_id = $id",
        { id: "PR_MERGED_1" },
      );
      expect(prRows.length).toBe(1);
      expect(prRows[0].state).toBe("MERGED");
      expect(prRows[0].merged_at_set).toBe(true);
    });
  });
});

// ─── 7. persistPullRequest ghost commit author ────────────────────────────────

describe("persistPullRequest ghost commit author", () => {
  it("commit.author is NONE; no extra user rows beyond PR author", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "PRGHOST");
      const repo = { id: repoId, name_with_owner: "testorgPRGHOST/repo" };

      const parsed: ParsedPullRequest = {
        github_node_id: "PR_GHOST_1",
        github_url: "https://github.com/testorgPRGHOST/repo/pull/9",
        number: 9,
        title: "Ghost Commit PR",
        body: "",
        state: "OPEN",
        closed_at: null,
        merged_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: "jkl012jkl012jkl012jkl012jkl012jkl012jkl012jkl012jkl012jkl012jkl0",
        author: {
          github_node_id: "U_GHOST_PR",
          login: "prauthor",
          is_bot: false,
          github_url: "https://github.com/prauthor",
        },
        labels: [],
        commits: [
          {
            github_node_id: "C_GHOST_1",
            oid: "ghost001",
            github_url: "https://github.com/testorgPRGHOST/repo/commit/ghost001",
            message_headline: "Ghost commit",
            message_body: null,
            committed_date: new Date("2026-01-01T10:00:00Z"),
            author: null,
          },
        ],
        closing_issue_node_ids: [],
      };

      await persistPullRequest(db, repo, parsed);

      const [isNoneRows] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT author IS NONE AS is_none FROM commit WHERE github_node_id = $id",
        { id: "C_GHOST_1" },
      );
      expect(isNoneRows.length).toBe(1);
      expect(isNoneRows[0].is_none).toBe(true);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(1);
    });
  });
});
