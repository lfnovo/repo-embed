import { describe, it, expect, mock, spyOn } from "bun:test";
import type { Surreal } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";

let _testDb: Surreal;

mock.module("../clients/surreal.ts", () => ({
  withDb: (fn: (db: Surreal) => Promise<unknown>) => fn(_testDb),
}));

const { default: run } = await import("./remove.ts");

async function seedRegisteredRepo(db: Surreal): Promise<void> {
  await db.query(`
    CREATE org:removeorg CONTENT {
      github_node_id: 'U_remove_test',
      github_url: 'https://github.com/lfnovo',
      login: 'lfnovo',
      name: 'Luis Novo',
      kind: 'User',
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }
  `);

  await db.query(`
    CREATE repo:removerepo CONTENT {
      github_node_id: 'R_remove_test',
      github_url: 'https://github.com/lfnovo/esperanto',
      owner: org:removeorg,
      name: 'esperanto',
      name_with_owner: 'lfnovo/esperanto',
      description: NONE,
      is_private: false,
      registered_at: time::now(),
      last_synced_at: NONE,
      created_at: time::now(),
      updated_at: time::now()
    }
  `);
}

describe("remove command", () => {
  it("unregisters a registered repo (happy path)", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedRegisteredRepo(db);

      await run(["lfnovo/esperanto"]);

      const [[repo]] = await db.query<
        [[{ registered_at: unknown; last_synced_at: unknown }]]
      >(
        "SELECT registered_at, last_synced_at FROM repo:removerepo",
      );
      expect(repo.registered_at == null).toBe(true);
      expect(repo.last_synced_at == null).toBe(true);
    });
  });

  it("exits 1 with error for unknown repo", async () => {
    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errLines.push(args.join(" "));

    const exitSpy = spyOn(process, "exit").mockImplementation(
      ((_code?: number | string) => {
        throw new Error(`process.exit(${_code})`);
      }) as typeof process.exit,
    );

    try {
      await withTestDb(async (db) => {
        _testDb = db;
        await run(["unknown/nope"]);
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toContain("process.exit(1)");
      expect(errLines.join(" ")).toContain("repo not found");
    } finally {
      console.error = origErr;
      exitSpy.mockRestore();
    }
  });

  it("exits 1 for already-unregistered repo", async () => {
    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errLines.push(args.join(" "));

    const exitSpy = spyOn(process, "exit").mockImplementation(
      ((_code?: number | string) => {
        throw new Error(`process.exit(${_code})`);
      }) as typeof process.exit,
    );

    try {
      await withTestDb(async (db) => {
        _testDb = db;

        // Seed org and repo with registered_at = NONE
        await db.query(`
          CREATE org:unreg_org CONTENT {
            github_node_id: 'U_unreg',
            github_url: 'https://github.com/lfnovo',
            login: 'lfnovo',
            name: 'Luis Novo',
            kind: 'User',
            created_at: time::now(),
            updated_at: time::now(),
            deleted_at: NONE
          }
        `);
        await db.query(`
          CREATE repo:unreg_repo CONTENT {
            github_node_id: 'R_unreg',
            github_url: 'https://github.com/lfnovo/esperanto',
            owner: org:unreg_org,
            name: 'esperanto',
            name_with_owner: 'lfnovo/esperanto',
            description: NONE,
            is_private: false,
            registered_at: NONE,
            last_synced_at: NONE,
            created_at: time::now(),
            updated_at: time::now()
          }
        `);

        await run(["lfnovo/esperanto"]);
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toContain("process.exit(1)");
      expect(errLines.join(" ")).toContain("not registered");
    } finally {
      console.error = origErr;
      exitSpy.mockRestore();
    }
  });

  it("--purge --yes soft-deletes children and unregisters repo", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedRegisteredRepo(db);

      // Add a child issue linked to the repo
      await db.query(`
        CREATE issue:testissue CONTENT {
          github_node_id: 'I_test',
          github_url: 'https://github.com/lfnovo/esperanto/issues/1',
          repo: repo:removerepo,
          number: 1,
          title: 'Test issue',
          body: 'body',
          state: 'OPEN',
          state_reason: NONE,
          author: NONE,
          closed_at: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: NONE,
          embedding: NONE
        }
      `);

      await run(["lfnovo/esperanto", "--purge", "--yes"]);

      // Issue should be tombstoned
      const [[issue]] = await db.query<[[{ deleted_at: unknown }]]>(
        "SELECT deleted_at FROM issue:testissue",
      );
      expect(issue.deleted_at).not.toBeNull();
      expect(issue.deleted_at).not.toBeUndefined();

      // Repo should be unregistered
      const [[repo]] = await db.query<[[{ registered_at: unknown }]]>(
        "SELECT registered_at FROM repo:removerepo",
      );
      expect(repo.registered_at == null).toBe(true);
    });
  });
});
