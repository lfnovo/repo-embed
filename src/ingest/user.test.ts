import { describe, it, expect } from "bun:test";
import { withTestDb } from "../test_utils/with_test_db.ts";
import { upsertUser } from "./user.ts";
import type { ParsedUser } from "./types.ts";

const testUser: ParsedUser = {
  github_node_id: "U_1234",
  login: "testuser",
  is_bot: false,
  github_url: "https://github.com/testuser",
};

describe("upsertUser", () => {
  it("returns same id on second call and leaves exactly 1 row", async () => {
    await withTestDb(async (db) => {
      const id1 = await upsertUser(db, testUser);
      const id2 = await upsertUser(db, testUser);

      expect(id1).toBe(id2);

      const [rows] = await db.query<[Array<unknown>]>(
        "SELECT id FROM user WHERE github_node_id = $n",
        { n: testUser.github_node_id },
      );
      expect(rows.length).toBe(1);
    });
  });
});
