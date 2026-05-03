import { describe, it, expect, mock } from "bun:test";
import type { Surreal } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";

let _testDb: Surreal;

mock.module("../clients/surreal.ts", () => ({
  withDb: (fn: (db: Surreal) => Promise<unknown>) => fn(_testDb),
}));

const { default: run } = await import("./list.ts");

async function seedRepos(db: Surreal): Promise<void> {
  await db.query(`
    CREATE org:testorg CONTENT {
      github_node_id: 'U_list_test',
      github_url: 'https://github.com/testorg',
      login: 'testorg',
      name: 'Test Org',
      kind: 'Organization',
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }
  `);

  // Registered repo with last_synced_at set
  await db.query(`
    CREATE repo:listrepo1 CONTENT {
      github_node_id: 'R_list1',
      github_url: 'https://github.com/testorg/alpha',
      owner: org:testorg,
      name: 'alpha',
      name_with_owner: 'testorg/alpha',
      description: NONE,
      is_private: false,
      registered_at: time::now(),
      last_synced_at: <datetime>'2024-03-15T10:30:00Z',
      created_at: time::now(),
      updated_at: time::now()
    }
  `);

  // Registered repo WITHOUT last_synced_at
  await db.query(`
    CREATE repo:listrepo2 CONTENT {
      github_node_id: 'R_list2',
      github_url: 'https://github.com/testorg/beta',
      owner: org:testorg,
      name: 'beta',
      name_with_owner: 'testorg/beta',
      description: NONE,
      is_private: false,
      registered_at: time::now(),
      last_synced_at: NONE,
      created_at: time::now(),
      updated_at: time::now()
    }
  `);

  // Unregistered repo
  await db.query(`
    CREATE repo:listrepo3 CONTENT {
      github_node_id: 'R_list3',
      github_url: 'https://github.com/testorg/gamma',
      owner: org:testorg,
      name: 'gamma',
      name_with_owner: 'testorg/gamma',
      description: NONE,
      is_private: false,
      registered_at: NONE,
      last_synced_at: NONE,
      created_at: time::now(),
      updated_at: time::now()
    }
  `);
}

function captureLog(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    fn()
      .then(() => {
        console.log = orig;
        resolve(lines.join("\n"));
      })
      .catch((err) => {
        console.log = orig;
        reject(err as Error);
      });
  });
}

describe("list command", () => {
  it("human format shows registered repos and not unregistered", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedRepos(db);

      const output = await captureLog(() => run([]));

      expect(output).toContain("testorg/alpha");
      expect(output).toContain("testorg/beta");
      expect(output).not.toContain("testorg/gamma");
      expect(output).toContain("(never)");
      expect(output).toMatch(/2024-03-15/);
    });
  });

  it("--json returns parseable array of registered repos", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedRepos(db);

      const output = await captureLog(() => run(["--json"]));

      const parsed = JSON.parse(output) as Array<{
        name_with_owner: string;
        last_synced_at?: unknown;
      }>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      const names = parsed.map((r) => r.name_with_owner);
      expect(names).toContain("testorg/alpha");
      expect(names).toContain("testorg/beta");
    });
  });

  it("empty DB shows no repos registered message", async () => {
    await withTestDb(async (db) => {
      _testDb = db;

      const output = await captureLog(() => run([]));

      expect(output).toContain("no repos registered");
    });
  });
});
