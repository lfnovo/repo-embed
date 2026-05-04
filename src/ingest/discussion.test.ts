import { describe, it, expect, mock } from "bun:test";
import { withTestDb } from "../test_utils/with_test_db.ts";

import page1 from "./__fixtures__/discussions_page_1.json";
import page2 from "./__fixtures__/discussions_page_2.json";

let ghProbeResult: unknown = { repository: { hasDiscussionsEnabled: true } };

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
  gh: async () => ghProbeResult,
}));

const { fetchDiscussions, persistDiscussion, computeContentHash, resolveDiscussionAnswerLinks } =
  await import("./discussion.ts");
type ParsedDiscussion = Parameters<typeof persistDiscussion>[2];

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

// ─── 1. computeContentHash ────────────────────────────────────────────────────

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

// ─── 2. persistDiscussion idempotency ─────────────────────────────────────────

describe("persistDiscussion idempotency", () => {
  it("persist same discussion twice leaves exactly 1 discussion, 1 user, and 1 has_label edge", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "DA");
      const repo = { id: repoId, name_with_owner: "testorgDA/repo" };

      const parsed: ParsedDiscussion = {
        github_node_id: "D_IDEM_1",
        github_url: "https://github.com/testorgDA/repo/discussions/10",
        number: 10,
        title: "Idempotency Test Discussion",
        body: "Some body text",
        closed_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: computeContentHash("Idempotency Test Discussion", "Some body text"),
        category_name: "Q&A",
        answer_chosen_at: new Date("2026-01-03T00:00:00Z"),
        author: {
          github_node_id: "U_IDEM_D1",
          login: "testuser",
          is_bot: false,
          github_url: "https://github.com/testuser",
        },
        labels: [
          { github_node_id: "LB_IDEM_D1", name: "bug", color: "d73a4a", description: "A bug" },
        ],
      };

      await persistDiscussion(db, repo, parsed);
      await persistDiscussion(db, repo, parsed);

      const [discRows] = await db.query<[Array<unknown>]>("SELECT id FROM discussion");
      expect(discRows.length).toBe(1);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(1);

      const [edgeRows] = await db.query<[Array<unknown>]>("SELECT id FROM has_label");
      expect(edgeRows.length).toBe(1);
    });
  });
});

// ─── 3. author: null path ─────────────────────────────────────────────────────

describe("persistDiscussion author: null", () => {
  it("stores author as NONE and creates no user rows", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "DB");
      const repo = { id: repoId, name_with_owner: "testorgDB/repo" };

      const parsed: ParsedDiscussion = {
        github_node_id: "D_NULL_AUTH",
        github_url: "https://github.com/testorgDB/repo/discussions/5",
        number: 5,
        title: "No Author Discussion",
        body: "",
        closed_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-10T00:00:00Z"),
        content_hash: computeContentHash("No Author Discussion", ""),
        category_name: "General",
        answer_chosen_at: null,
        author: null,
        labels: [],
      };

      await persistDiscussion(db, repo, parsed);

      const [isNoneRows] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT author IS NONE AS is_none FROM discussion WHERE github_node_id = $id",
        { id: "D_NULL_AUTH" },
      );
      expect(isNoneRows.length).toBe(1);
      expect(isNoneRows[0].is_none).toBe(true);

      const [userRows] = await db.query<[Array<unknown>]>("SELECT id FROM user");
      expect(userRows.length).toBe(0);
    });
  });
});

// ─── 4. category capture ──────────────────────────────────────────────────────

describe("persistDiscussion category capture", () => {
  it("stores category_name as the category field in the DB", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "DC");
      const repo = { id: repoId, name_with_owner: "testorgDC/repo" };

      const parsed: ParsedDiscussion = {
        github_node_id: "D_CAT_1",
        github_url: "https://github.com/testorgDC/repo/discussions/7",
        number: 7,
        title: "Category Test",
        body: "body",
        closed_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: computeContentHash("Category Test", "body"),
        category_name: "Ideas",
        answer_chosen_at: null,
        author: null,
        labels: [],
      };

      await persistDiscussion(db, repo, parsed);

      const [rows] = await db.query<[Array<{ category: string }>]>(
        "SELECT category FROM discussion WHERE github_node_id = $id",
        { id: "D_CAT_1" },
      );
      expect(rows.length).toBe(1);
      expect(rows[0].category).toBe("Ideas");
    });
  });
});

// ─── 5. answer_chosen_at ─────────────────────────────────────────────────────

describe("persistDiscussion answer_chosen_at", () => {
  it("stores non-null answer_chosen_at as a datetime, null as NONE", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "DD");
      const repo = { id: repoId, name_with_owner: "testorgDD/repo" };

      const withAnswer: ParsedDiscussion = {
        github_node_id: "D_ANS_1",
        github_url: "https://github.com/testorgDD/repo/discussions/8",
        number: 8,
        title: "Answered Discussion",
        body: "body",
        closed_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: computeContentHash("Answered Discussion", "body"),
        category_name: "Q&A",
        answer_chosen_at: new Date("2026-01-05T00:00:00Z"),
        author: null,
        labels: [],
      };

      const withoutAnswer: ParsedDiscussion = {
        github_node_id: "D_ANS_2",
        github_url: "https://github.com/testorgDD/repo/discussions/9",
        number: 9,
        title: "Unanswered Discussion",
        body: "body",
        closed_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
        content_hash: computeContentHash("Unanswered Discussion", "body"),
        category_name: "Q&A",
        answer_chosen_at: null,
        author: null,
        labels: [],
      };

      await persistDiscussion(db, repo, withAnswer);
      await persistDiscussion(db, repo, withoutAnswer);

      const [answeredRows] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT answer_chosen_at IS NONE AS is_none FROM discussion WHERE github_node_id = $id",
        { id: "D_ANS_1" },
      );
      expect(answeredRows[0].is_none).toBe(false);

      const [unansweredRows] = await db.query<[Array<{ is_none: boolean }>]>(
        "SELECT answer_chosen_at IS NONE AS is_none FROM discussion WHERE github_node_id = $id",
        { id: "D_ANS_2" },
      );
      expect(unansweredRows[0].is_none).toBe(true);
    });
  });
});

// ─── 6. fetchDiscussions end-to-end ───────────────────────────────────────────

describe("fetchDiscussions mock", () => {
  it("yields all discussions from both fixture pages with correct shape", async () => {
    ghProbeResult = { repository: { hasDiscussionsEnabled: true } };

    const discussions: ParsedDiscussion[] = [];
    for await (const d of fetchDiscussions("test", "repo")) {
      discussions.push(d);
    }

    expect(discussions.length).toBe(3);

    const ids = discussions.map((d) => d.github_node_id);
    expect(ids).toContain("D_001");
    expect(ids).toContain("D_002");
    expect(ids).toContain("D_003");

    for (const d of discussions) {
      expect(d.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    const d1 = discussions.find((d) => d.github_node_id === "D_001")!;
    expect(d1.answer_chosen_at).not.toBeNull();
    expect(d1.category_name).toBe("Q&A");
    expect(d1.author).not.toBeNull();
    expect(d1.author?.login).toBe("testuser");
    expect(d1.labels.length).toBe(1);

    const d3 = discussions.find((d) => d.github_node_id === "D_003")!;
    expect(d3.author).not.toBeNull();
    expect(d3.author?.is_bot).toBe(true);
  });
});

// ─── 7. fetchDiscussions — since filter ──────────────────────────────────────

describe("fetchDiscussions — since filter", () => {
  it("yields all items when since predates all fixture items", async () => {
    ghProbeResult = { repository: { hasDiscussionsEnabled: true } };
    const items: ParsedDiscussion[] = [];
    for await (const d of fetchDiscussions("test", "repo", new Date("2020-01-01"))) {
      items.push(d);
    }
    // All fixture items have updatedAt in 2026; none trigger early-break
    expect(items.length).toBe(3);
  });

  it("early-breaks after first item when since falls within fixture range", async () => {
    ghProbeResult = { repository: { hasDiscussionsEnabled: true } };
    const items: ParsedDiscussion[] = [];
    // D_001 updatedAt is 2026-01-02T00:00:00Z; since is noon that day → break fires after D_001
    for await (const d of fetchDiscussions("test", "repo", new Date("2026-01-02T12:00:00Z"))) {
      items.push(d);
    }
    expect(items.length).toBe(1);
    expect(items[0].github_node_id).toBe("D_001");
  });
});

// ─── 7. fetchDiscussions hasDiscussionsEnabled=false ─────────────────────────

describe("fetchDiscussions hasDiscussionsEnabled=false", () => {
  it("yields zero items when discussions are disabled", async () => {
    ghProbeResult = { repository: { hasDiscussionsEnabled: false } };

    const discussions: ParsedDiscussion[] = [];
    for await (const d of fetchDiscussions("test", "repo")) {
      discussions.push(d);
    }

    expect(discussions.length).toBe(0);

    // restore for subsequent tests
    ghProbeResult = { repository: { hasDiscussionsEnabled: true } };
  });
});

// ─── 8. resolveDiscussionAnswerLinks ─────────────────────────────────────────

describe("resolveDiscussionAnswerLinks", () => {
  it("returns { resolved: 0, pending: 0 } on empty DB", async () => {
    await withTestDb(async (db) => {
      const repoId = await setupRepo(db, "DE");
      const repo = { id: repoId, name_with_owner: "testorgDE/repo" };
      const result = await resolveDiscussionAnswerLinks(db, repo);
      expect(result).toEqual({ resolved: 0, pending: 0 });
    });
  });
});
