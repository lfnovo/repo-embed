import { describe, it, expect, mock } from "bun:test";
import { StringRecordId } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";
import type { ParsedLabel } from "./types.ts";

const catalogPage1 = {
  repository: {
    labels: {
      nodes: [
        { id: "LBC_1", name: "alpha", color: "ff0000", description: "Alpha label" },
        { id: "LBC_2", name: "beta", color: "00ff00", description: null },
      ],
      pageInfo: { hasNextPage: true, endCursor: "cursor1" },
    },
  },
};

const catalogPage2 = {
  repository: {
    labels: {
      nodes: [
        { id: "LBC_3", name: "gamma", color: "0000ff", description: "Gamma label" },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

mock.module("../clients/github.ts", () => ({
  paginate: async function* (
    _query: string,
    _variables: unknown,
    selectConnection: (data: unknown) => {
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    },
  ) {
    for (const page of [catalogPage1, catalogPage2]) {
      const connection = selectConnection(page);
      for (const node of connection.nodes) {
        yield node;
      }
    }
  },
  gh: async () => ({}),
}));

const { upsertLabelsAndEdges, fetchLabelsCatalog, persistLabelCatalog } = await import(
  "./labels.ts"
);

const labels: ParsedLabel[] = [
  { github_node_id: "LB_1", name: "bug", color: "d73a4a", description: "Something broken" },
  { github_node_id: "LB_2", name: "enhancement", color: "a2eeef", description: null },
];

async function setupIssue(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  suffix = "1",
): Promise<{ issueId: string; repoId: string }> {
  const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE org CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test",
      login: "test",
      name: "Test",
      kind: "User",
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    { nid: `ORG_${suffix}` },
  );
  const orgId = orgRows[0].id;

  const [repoRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE repo CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo",
      name: "repo",
      name_with_owner: "test/repo",
      description: NONE,
      is_private: false,
      owner: $orgId,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    { nid: `REPO_${suffix}`, orgId },
  );
  const repoId = String(repoRows[0].id);

  const [issueRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE issue CONTENT {
      github_node_id: $nid,
      github_url: "https://github.com/test/repo/issues/1",
      repo: $repoId,
      number: 1,
      title: "Test issue",
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
    { nid: `ISSUE_${suffix}`, repoId: new StringRecordId(repoId) },
  );
  const issueId = String(issueRows[0].id);

  return { issueId, repoId };
}

// ─── 1. upsertLabelsAndEdges basic idempotency ───────────────────────────────

describe("upsertLabelsAndEdges", () => {
  it("creates 2 labels and 2 edges, no duplicates on second call", async () => {
    await withTestDb(async (db) => {
      const { issueId } = await setupIssue(db);

      await upsertLabelsAndEdges(db, issueId, labels);

      const [labelRows1] = await db.query<[Array<unknown>]>("SELECT id FROM label");
      const [edgeRows1] = await db.query<[Array<unknown>]>("SELECT id FROM has_label");
      expect(labelRows1.length).toBe(2);
      expect(edgeRows1.length).toBe(2);

      await upsertLabelsAndEdges(db, issueId, labels);

      const [labelRows2] = await db.query<[Array<unknown>]>("SELECT id FROM label");
      const [edgeRows2] = await db.query<[Array<unknown>]>("SELECT id FROM has_label");
      expect(labelRows2.length).toBe(2);
      expect(edgeRows2.length).toBe(2);
    });
  });
});

// ─── 2. Replace-all semantics ─────────────────────────────────────────────────

describe("upsertLabelsAndEdges replace-all semantics", () => {
  it("after second call with 1 different label, exactly 1 has_label edge remains", async () => {
    await withTestDb(async (db) => {
      const { issueId } = await setupIssue(db);

      const threeLabels: ParsedLabel[] = [
        { github_node_id: "LB_A", name: "alpha", color: "ff0000", description: null },
        { github_node_id: "LB_B", name: "beta", color: "00ff00", description: null },
        { github_node_id: "LB_C", name: "gamma", color: "0000ff", description: null },
      ];
      await upsertLabelsAndEdges(db, issueId, threeLabels);

      const [edgeRows1] = await db.query<[Array<unknown>]>("SELECT id FROM has_label");
      expect(edgeRows1.length).toBe(3);

      const oneLabel: ParsedLabel[] = [
        { github_node_id: "LB_D", name: "delta", color: "ffffff", description: null },
      ];
      await upsertLabelsAndEdges(db, issueId, oneLabel);

      const [edgeRows2] = await db.query<[Array<unknown>]>("SELECT id FROM has_label");
      expect(edgeRows2.length).toBe(1);

      const [oldEdges] = await db.query<[Array<unknown>]>(
        "SELECT id FROM has_label WHERE out.github_node_id IN ['LB_A', 'LB_B', 'LB_C']",
      );
      expect(oldEdges.length).toBe(0);
    });
  });
});

// ─── 3. fetchLabelsCatalog mock ───────────────────────────────────────────────

describe("fetchLabelsCatalog mock", () => {
  it("yields all labels from both fixture pages with correct ParsedLabel shape", async () => {
    const results: ParsedLabel[] = [];
    for await (const label of fetchLabelsCatalog("owner", "repo")) {
      results.push(label);
    }

    expect(results.length).toBe(3);
    expect(results[0]).toEqual({
      github_node_id: "LBC_1",
      name: "alpha",
      color: "ff0000",
      description: "Alpha label",
    });
    expect(results[1]).toEqual({
      github_node_id: "LBC_2",
      name: "beta",
      color: "00ff00",
      description: null,
    });
    expect(results[2]).toEqual({
      github_node_id: "LBC_3",
      name: "gamma",
      color: "0000ff",
      description: "Gamma label",
    });
  });
});

// ─── 4. persistLabelCatalog idempotency ──────────────────────────────────────

describe("persistLabelCatalog idempotency", () => {
  it("calling twice with same ParsedLabel produces exactly 1 label row with correct fields", async () => {
    await withTestDb(async (db) => {
      const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT {
          github_node_id: "ORG_PC",
          github_url: "https://github.com/pc",
          login: "pc",
          name: "PC",
          kind: "User",
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const orgId = orgRows[0].id;

      const [repoRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE repo CONTENT {
          github_node_id: "REPO_PC",
          github_url: "https://github.com/pc/repo",
          name: "repo",
          name_with_owner: "pc/repo",
          description: NONE,
          is_private: false,
          owner: $orgId,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
        { orgId },
      );
      const repoId = String(repoRows[0].id);
      const repo = { id: repoId, name_with_owner: "pc/repo" };

      const parsed: ParsedLabel = {
        github_node_id: "LBC_IDEM",
        name: "bug",
        color: "d73a4a",
        description: "A bug",
      };

      await persistLabelCatalog(db, repo, parsed);
      await persistLabelCatalog(db, repo, parsed);

      const [labelRows] = await db.query<
        [Array<{ name: string; color: string; repo: unknown }>]
      >("SELECT name, color, repo FROM label WHERE github_node_id = $id", {
        id: "LBC_IDEM",
      });
      expect(labelRows.length).toBe(1);
      expect(labelRows[0].name).toBe("bug");
      expect(labelRows[0].color).toBe("d73a4a");
      expect(String(labelRows[0].repo)).toBe(repoId);
    });
  });
});
