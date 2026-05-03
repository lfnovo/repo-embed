import { describe, it, expect } from "bun:test";
import { withTestDb } from "../test_utils/with_test_db.ts";
import { upsertLabelsAndEdges } from "./labels.ts";
import type { ParsedLabel } from "./types.ts";

const labels: ParsedLabel[] = [
  { github_node_id: "LB_1", name: "bug", color: "d73a4a", description: "Something broken" },
  { github_node_id: "LB_2", name: "enhancement", color: "a2eeef", description: null },
];

describe("upsertLabelsAndEdges", () => {
  it("creates 2 labels and 2 edges, no duplicates on second call", async () => {
    await withTestDb(async (db) => {
      const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE org CONTENT {
          github_node_id: "ORG_1",
          github_url: "https://github.com/test",
          login: "test",
          name: "Test",
          kind: "User",
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const orgId = orgRows[0].id;

      const [repoRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE repo CONTENT {
          github_node_id: "REPO_1",
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
        { orgId },
      );
      const repoId = repoRows[0].id;

      const [issueRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE issue CONTENT {
          github_node_id: "ISSUE_1",
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
        { repoId },
      );
      const issueId = String(issueRows[0].id);

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
