import { describe, it, expect, mock } from "bun:test";
import type { Surreal } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";

let testDb: Surreal | null = null;
let ghCallCount = 0;

const REPO_GH_FIXTURE = {
  repository: {
    id: "REPO_GH_ID",
    nameWithOwner: "lfnovo/test-repo",
    description: null,
    url: "https://github.com/lfnovo/test-repo",
    isPrivate: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    owner: {
      __typename: "User",
      id: "ORG_GH_ID",
      login: "lfnovo",
      url: "https://github.com/lfnovo",
      name: "Luis",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  },
};

mock.module("../clients/github.ts", () => ({
  gh: async (query: string) => {
    ghCallCount++;
    if (query.includes("nameWithOwner") || query.includes("isPrivate")) {
      return REPO_GH_FIXTURE;
    }
    if (query.includes("hasDiscussionsEnabled")) {
      return { repository: { hasDiscussionsEnabled: false } };
    }
    return {};
  },
  paginate: async function* (
    query: string,
    _variables: unknown,
    selectConnection: (data: unknown) => {
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    },
  ) {
    let fixture: unknown;

    if (query.includes("FetchLabelsCatalog")) {
      fixture = {
        repository: {
          labels: {
            nodes: [{ id: "LBL_SYNC_001", name: "enhancement", color: "84b6eb", description: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    } else if (query.includes("FetchIssues")) {
      fixture = {
        repository: {
          issues: {
            nodes: [
              {
                id: "I_SYNC_001",
                url: "https://github.com/lfnovo/test-repo/issues/1",
                number: 1,
                title: "Test Issue",
                body: null,
                state: "OPEN",
                stateReason: null,
                closedAt: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
                author: null,
                labels: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    } else if (query.includes("FetchPullRequests")) {
      fixture = {
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_SYNC_001",
                url: "https://github.com/lfnovo/test-repo/pull/1",
                number: 1,
                title: "Test PR",
                body: null,
                state: "OPEN",
                closedAt: null,
                mergedAt: null,
                mergedBy: null,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
                author: null,
                labels: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                commits: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                closingIssuesReferences: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    } else if (query.includes("FetchIssueComments")) {
      fixture = {
        repository: {
          issue: {
            id: "I_SYNC_001",
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      };
    } else if (query.includes("FetchPRComments")) {
      fixture = {
        repository: {
          pullRequest: {
            id: "PR_SYNC_001",
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      };
    } else if (query.includes("FetchDiscussionComments")) {
      fixture = {
        repository: {
          discussion: {
            id: "D_001",
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      };
    } else {
      fixture = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    }

    const connection = selectConnection(fixture);
    for (const node of connection.nodes) {
      yield node;
    }
  },
}));

mock.module("../clients/surreal.ts", () => ({
  withDb: (fn: (db: Surreal) => Promise<unknown>) => fn(testDb!),
}));

const { default: run } = await import("./sync.ts");

describe("sync command — happy path", () => {
  it("runs all pipeline steps and sets last_synced_at", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      ghCallCount = 0;

      // Pre-seed org
      const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT {
          github_node_id: 'ORG_GH_ID',
          github_url: 'https://github.com/lfnovo',
          login: 'lfnovo',
          name: 'Luis',
          kind: 'User',
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const orgId = orgRows[0].id;

      // Pre-seed repo
      await db.query(
        `CREATE repo CONTENT {
          github_node_id: 'REPO_GH_ID',
          github_url: 'https://github.com/lfnovo/test-repo',
          name: 'test-repo',
          name_with_owner: 'lfnovo/test-repo',
          description: NONE,
          is_private: false,
          owner: $owner,
          created_at: time::now(),
          updated_at: time::now(),
          registered_at: time::now()
        }`,
        { owner: orgId },
      );

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      try { await run(["lfnovo/test-repo"]); } finally { console.log = origLog; }

      expect(logs.some(l => l === 'Sync mode: full')).toBe(true);

      const [[repoRow]] = await db.query<[[{ last_synced_at: unknown }]]>(
        "SELECT last_synced_at FROM repo WHERE name_with_owner = $nwo",
        { nwo: "lfnovo/test-repo" },
      );
      expect(repoRow.last_synced_at).not.toBeNull();
      expect(repoRow.last_synced_at).not.toBeUndefined();

      const [[{ count: labelCount }]] = await db.query<[[{ count: number }]]>(
        "SELECT count() FROM label GROUP ALL",
      );
      expect(labelCount).toBe(1);

      const [[{ count: issueCount }]] = await db.query<[[{ count: number }]]>(
        "SELECT count() FROM issue GROUP ALL",
      );
      expect(issueCount).toBe(1);

      const [[{ count: prCount }]] = await db.query<[[{ count: number }]]>(
        "SELECT count() FROM pull_request GROUP ALL",
      );
      expect(prCount).toBe(1);
    });
    testDb = null;
  });
});

describe("sync command — repo not registered", () => {
  it("rejects with 'not registered' and never calls gh", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      ghCallCount = 0;

      await expect(run(["unknown/repo"])).rejects.toThrow("not registered");
      expect(ghCallCount).toBe(0);
    });
    testDb = null;
  });
});

describe("sync command — incremental mode", () => {
  it("logs incremental mode with timestamp and updates last_synced_at", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      ghCallCount = 0;

      // Pre-seed org
      const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT {
          github_node_id: 'ORG_GH_ID',
          github_url: 'https://github.com/lfnovo',
          login: 'lfnovo',
          name: 'Luis',
          kind: 'User',
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const orgId = orgRows[0].id;

      // Pre-seed repo with last_synced_at already set (simulating a second sync)
      await db.query(
        `CREATE repo CONTENT {
          github_node_id: 'REPO_GH_ID',
          github_url: 'https://github.com/lfnovo/test-repo',
          name: 'test-repo',
          name_with_owner: 'lfnovo/test-repo',
          description: NONE,
          is_private: false,
          owner: $owner,
          created_at: time::now(),
          updated_at: time::now(),
          registered_at: time::now(),
          last_synced_at: $lastSyncedAt
        }`,
        { owner: orgId, lastSyncedAt: new Date('2024-06-01T00:00:00Z') },
      );

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      try { await run(["lfnovo/test-repo"]); } finally { console.log = origLog; }

      expect(logs.some(l => l.startsWith('Sync mode: incremental (since '))).toBe(true);

      const [[repoRow]] = await db.query<[[{ last_synced_at: unknown }]]>(
        "SELECT last_synced_at FROM repo WHERE name_with_owner = $nwo",
        { nwo: "lfnovo/test-repo" },
      );
      expect(new Date(String(repoRow.last_synced_at)) > new Date('2024-06-01T00:00:00Z')).toBe(true);
    });
    testDb = null;
  });
});

describe("sync command — --full flag", () => {
  it("forces full mode even when last_synced_at is set (flag after repo arg)", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      ghCallCount = 0;

      // Pre-seed org
      const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT {
          github_node_id: 'ORG_GH_ID',
          github_url: 'https://github.com/lfnovo',
          login: 'lfnovo',
          name: 'Luis',
          kind: 'User',
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const orgId = orgRows[0].id;

      // Pre-seed repo with last_synced_at set — would normally trigger incremental mode
      await db.query(
        `CREATE repo CONTENT {
          github_node_id: 'REPO_GH_ID',
          github_url: 'https://github.com/lfnovo/test-repo',
          name: 'test-repo',
          name_with_owner: 'lfnovo/test-repo',
          description: NONE,
          is_private: false,
          owner: $owner,
          created_at: time::now(),
          updated_at: time::now(),
          registered_at: time::now(),
          last_synced_at: $lastSyncedAt
        }`,
        { owner: orgId, lastSyncedAt: new Date('2024-06-01T00:00:00Z') },
      );

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      try { await run(["lfnovo/test-repo", "--full"]); } finally { console.log = origLog; }

      expect(logs.some(l => l === 'Sync mode: full')).toBe(true);

      const [[{ count: issueCount }]] = await db.query<[[{ count: number }]]>(
        "SELECT count() FROM issue GROUP ALL",
      );
      expect(issueCount).toBe(1);
    });
    testDb = null;
  });

  it("forces full mode when --full flag appears before the repo arg", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      ghCallCount = 0;

      // Pre-seed org
      const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT {
          github_node_id: 'ORG_GH_ID',
          github_url: 'https://github.com/lfnovo',
          login: 'lfnovo',
          name: 'Luis',
          kind: 'User',
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const orgId = orgRows[0].id;

      // Pre-seed repo with last_synced_at set
      await db.query(
        `CREATE repo CONTENT {
          github_node_id: 'REPO_GH_ID',
          github_url: 'https://github.com/lfnovo/test-repo',
          name: 'test-repo',
          name_with_owner: 'lfnovo/test-repo',
          description: NONE,
          is_private: false,
          owner: $owner,
          created_at: time::now(),
          updated_at: time::now(),
          registered_at: time::now(),
          last_synced_at: $lastSyncedAt
        }`,
        { owner: orgId, lastSyncedAt: new Date('2024-06-01T00:00:00Z') },
      );

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      try { await run(["--full", "lfnovo/test-repo"]); } finally { console.log = origLog; }

      expect(logs.some(l => l === 'Sync mode: full')).toBe(true);

      const [[{ count: issueCount }]] = await db.query<[[{ count: number }]]>(
        "SELECT count() FROM issue GROUP ALL",
      );
      expect(issueCount).toBe(1);
    });
    testDb = null;
  });
});
