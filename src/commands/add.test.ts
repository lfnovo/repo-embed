import { describe, it, expect, mock, spyOn } from "bun:test";
import type { Surreal } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";
import fixture from "./__fixtures__/repository_lfnovo_esperanto.json";

let _testDb: Surreal;

mock.module("../clients/github.ts", () => ({
  gh: async () => fixture,
}));

mock.module("../clients/surreal.ts", () => ({
  withDb: (fn: (db: Surreal) => Promise<unknown>) => fn(_testDb),
}));

const { default: run } = await import("./add.ts");

describe("add command", () => {
  it("creates org and repo on happy path", async () => {
    await withTestDb(async (db) => {
      _testDb = db;

      await run(["lfnovo/esperanto"]);

      const [orgRows] = await db.query<
        [Array<{ login: string; kind: string }>]
      >("SELECT login, kind FROM org WHERE login = 'lfnovo'");
      expect(orgRows.length).toBe(1);
      expect(orgRows[0].login).toBe("lfnovo");
      expect(orgRows[0].kind).toBe("User");

      const [repoRows] = await db.query<
        [Array<{ name_with_owner: string; registered_at: unknown }>]
      >(
        "SELECT name_with_owner, registered_at FROM repo WHERE name_with_owner = 'lfnovo/esperanto'",
      );
      expect(repoRows.length).toBe(1);
      expect(repoRows[0].name_with_owner).toBe("lfnovo/esperanto");
      expect(repoRows[0].registered_at).not.toBeNull();
      expect(repoRows[0].registered_at).not.toBeUndefined();
    });
  });

  it("preserves registered_at on second call (idempotency)", async () => {
    await withTestDb(async (db) => {
      _testDb = db;

      await run(["lfnovo/esperanto"]);

      const [[first]] = await db.query<[[{ registered_at: unknown }]]>(
        "SELECT registered_at FROM repo WHERE name_with_owner = 'lfnovo/esperanto'",
      );
      const firstValue = String(first.registered_at);

      await run(["lfnovo/esperanto"]);

      const [[second]] = await db.query<[[{ registered_at: unknown }]]>(
        "SELECT registered_at FROM repo WHERE name_with_owner = 'lfnovo/esperanto'",
      );
      const secondValue = String(second.registered_at);

      expect(secondValue).toBe(firstValue);
    });
  });

  it("exits 1 on bad arg (empty args)", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(
      ((_code?: number | string) => {
        throw new Error(`process.exit(${_code})`);
      }) as typeof process.exit,
    );

    try {
      await run([]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toContain("process.exit(1)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
