import { describe, it, expect, mock } from "bun:test";
import { withTestDb } from "../test_utils/with_test_db.ts";

import page1 from "./__fixtures__/issues_page_1.json";
import page2 from "./__fixtures__/issues_page_2.json";

mock.module("../clients/github.ts", () => ({
  paginate: async function* (
    _query: string,
    _variables: unknown,
    selectConnection: (data: unknown) => {
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    },
  ) {
    // Pages reversed and nodes reversed to simulate the DESC ordering
    // the production query requests (newest first across pages).
    for (const page of [page2, page1]) {
      const connection = selectConnection(page);
      for (const node of [...connection.nodes].reverse()) {
        yield node;
      }
    }
  },
  gh: async () => ({}),
}));

const { fetchIssues, persistIssue, computeContentHash } = await import("./issue.ts");
type ParsedIssue = Parameters<typeof persistIssue>[2];

// ─── 1. content_hash determinism ─────────────────────────────────────────────

describe("computeContentHash", () => {
  it("same (title, body) always produces the same hex string", () => {
    const h1 = computeContentHash("My Title", "Some body");
    const h2 = computeContentHash("My Title", "Some body");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CRLF and LF bodies produce the same hash", () => {
    const crlfHash = computeContentHash("T", "Hello\r\nWorld");
    const lfHash = computeContentHash("T", "Hello\nWorld");
    expect(crlfHash).toBe(lfHash);
  });

  it("different inputs produce different hashes", () => {
    const h1 = computeContentHash("Title A", "body");
    const h2 = computeContentHash("Title B", "body");
    expect(h1).not.toBe(h2);
  });

  it("null body is treated as empty string", () => {
    const h1 = computeContentHash("T", null);
    const h2 = computeContentHash("T", "");
    expect(h1).toBe(h2);
  });
});

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

// ─── 2. persistIssue idempotency ─────────────────────────────────────────────

describe("persistIssue idempotency", () => {
  it("persist same issue twice leaves exactly 1 issue, 1 user, and 1 has_label edge", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "A");
      const repo = { id: repoId, name_with_owner: "testorgA/repo" };

      const parsed: ParsedIssue = {
        github_node_id: "I_IDEM_1",
        github_url: "https://github.com/testorgA/repo/issues/10",
        number: 10,
        title: "Idempotency Test Issue",
        body: "Some body text",
        state: "OPEN",
        state_reason: null,
        closed_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: computeContentHash("Idempotency Test Issue", "Some body text"),
        author: {
          github_node_id: "U_IDEM_1",
          login: "testuser",
          is_bot: false,
          github_url: "https://github.com/testuser",
        },
        labels: [
          { github_node_id: "LB_IDEM_1", name: "bug", color: "d73a4a", description: "A bug" },
        ],
      };

      await persistIssue(db, repo, parsed);
      await persistIssue(db, repo, parsed);

      const [issueRows] = await db.query<[Array<unknown>]>("SELECT id FROM issue");
      expect(issueRows.length).toBe(1);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(1);

      const [edgeRows] = await db.query<[Array<unknown>]>("SELECT id FROM has_label");
      expect(edgeRows.length).toBe(1);
    });
  });
});

// ─── 3. author: null path ─────────────────────────────────────────────────────

describe("persistIssue author: null", () => {
  it("stores author as NONE and creates no user rows", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "B");
      const repo = { id: repoId, name_with_owner: "testorgB/repo" };

      const parsed: ParsedIssue = {
        github_node_id: "I_NULL_AUTH",
        github_url: "https://github.com/testorgB/repo/issues/5",
        number: 5,
        title: "No Author Issue",
        body: "",
        state: "CLOSED",
        state_reason: "COMPLETED",
        closed_at: new Date("2026-01-10T00:00:00Z"),
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-10T00:00:00Z"),
        content_hash: computeContentHash("No Author Issue", ""),
        author: null,
        labels: [],
      };

      await persistIssue(db, repo, parsed);

      const [isNoneRows] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT author IS NONE AS is_none FROM issue WHERE github_node_id = $id",
        { id: "I_NULL_AUTH" },
      );
      expect(isNoneRows.length).toBe(1);
      expect(isNoneRows[0].is_none).toBe(true);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(0);
    });
  });
});

// ─── 4. fetchIssues mock ──────────────────────────────────────────────────────

describe("fetchIssues mock", () => {
  it("yields all issues from both fixture pages with correct shape", async () => {
    const issues: ParsedIssue[] = [];
    for await (const issue of fetchIssues("test", "repo")) {
      issues.push(issue);
    }

    expect(issues.length).toBe(3);

    const ids = issues.map((i) => i.github_node_id);
    expect(ids).toContain("I_001");
    expect(ids).toContain("I_002");
    expect(ids).toContain("I_003");

    for (const issue of issues) {
      expect(issue.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    const issue1 = issues.find((i) => i.github_node_id === "I_001")!;
    expect(issue1.state).toBe("OPEN");
    expect(issue1.author).not.toBeNull();
    expect(issue1.author?.login).toBe("testuser");
    expect(issue1.labels.length).toBe(1);
    expect(issue1.labels[0].name).toBe("bug");

    const issue2 = issues.find((i) => i.github_node_id === "I_002")!;
    expect(issue2.state).toBe("CLOSED");
    expect(issue2.author).toBeNull();
    expect(issue2.labels.length).toBe(0);

    const issue3 = issues.find((i) => i.github_node_id === "I_003")!;
    expect(issue3.author).not.toBeNull();
    expect(issue3.author?.is_bot).toBe(true);
    expect(issue3.labels.length).toBe(1);
    expect(issue3.labels[0].name).toBe("dependencies");
  });

  it("CRLF in fixture body is normalized to LF", async () => {
    const issues: ParsedIssue[] = [];
    for await (const issue of fetchIssues("test", "repo")) {
      issues.push(issue);
    }
    const issue1 = issues.find((i) => i.github_node_id === "I_001")!;
    expect(issue1.body).not.toContain("\r\n");
    expect(issue1.body).toContain("\n");
  });
});

// ─── 5. fetchIssues — since filter ───────────────────────────────────────────

describe("fetchIssues — since filter", () => {
  it("yields all items when since predates all fixture items", async () => {
    const items: ParsedIssue[] = [];
    for await (const issue of fetchIssues("test", "repo", new Date("2020-01-01"))) {
      items.push(issue);
    }
    // All fixture items have updatedAt in 2026; none trigger early-break
    expect(items.length).toBe(3);
  });

  it("yields newest-first and early-breaks before items at or older than since", async () => {
    const items: ParsedIssue[] = [];
    // Fixture (DESC): I_003 (Jan 5) → I_002 (Jan 3) → I_001 (Jan 2).
    // since = Jan 4 cuts between I_003 and I_002 → expect [I_003] and the
    // loop must terminate before yielding I_002.
    for await (const issue of fetchIssues("test", "repo", new Date("2026-01-04T00:00:00Z"))) {
      items.push(issue);
    }
    expect(items.map((i) => i.github_node_id)).toEqual(["I_003"]);
  });
});
