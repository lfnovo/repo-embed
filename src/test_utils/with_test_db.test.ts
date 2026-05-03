import { describe, it, expect } from "bun:test";
import { withTestDb } from "./with_test_db.ts";

describe("withTestDb", () => {
  it("round-trips a record through the in-memory schema", async () => {
    const login = await withTestDb(async (db) => {
      await db.query(`
        CREATE org:testorg CONTENT {
          github_node_id: "U_test",
          github_url: "https://github.com/testorg",
          login: "testorg",
          name: "Test Org",
          kind: "Organization",
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }
      `);
      const [[record]] = await db.query<[[{ login: string }]]>(
        "SELECT login FROM org:testorg"
      );
      return record.login;
    });

    expect(login).toBe("testorg");
  });
});
