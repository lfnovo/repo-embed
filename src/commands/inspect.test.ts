import { describe, it, expect, mock, spyOn } from "bun:test";
import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";

let _testDb: Surreal;
let _withDbCallCount = 0;
let _withDbFailOnCall: number | null = null;

mock.module("../clients/surreal.ts", () => ({
  withDb: async (fn: (db: Surreal) => Promise<unknown>) => {
    _withDbCallCount++;
    if (_withDbFailOnCall !== null && _withDbCallCount === _withDbFailOnCall) {
      throw new Error("simulated db failure");
    }
    return fn(_testDb);
  },
}));

const { default: run } = await import("./inspect.ts");

// ── Capture helpers ────────────────────────────────────────────────────────────

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

function captureError(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(" "));
    fn()
      .then(() => {
        console.error = orig;
        resolve(lines.join("\n"));
      })
      .catch(() => {
        console.error = orig;
        resolve(lines.join("\n"));
      });
  });
}

// ── Seed ───────────────────────────────────────────────────────────────────────

async function seedInspect(db: Surreal): Promise<void> {
  // org
  await db.query(`
    CREATE org:inspectorg CONTENT {
      github_node_id: 'U_inspect',
      github_url: 'https://github.com/testorg',
      login: 'testorg',
      name: 'Test Org',
      kind: 'Organization',
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }
  `);

  // repo (with registered_at)
  await db.query(`
    CREATE repo:inspectrepo CONTENT {
      github_node_id: 'R_inspect',
      github_url: 'https://github.com/testorg/testrepo',
      owner: org:inspectorg,
      name: 'testrepo',
      name_with_owner: 'testorg/testrepo',
      description: NONE,
      is_private: false,
      registered_at: time::now(),
      last_synced_at: NONE,
      created_at: time::now(),
      updated_at: time::now()
    }
  `);

  // issue 1 — no embedding
  const [issue1Rows] = await db.query<[Array<{ id: unknown }>]>(`
    CREATE issue:inspect1 CONTENT {
      github_node_id: 'I_inspect1',
      github_url: 'https://github.com/testorg/testrepo/issues/1',
      repo: repo:inspectrepo,
      number: 1,
      title: 'First Issue',
      body: 'Some body',
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

  // issue 2 — with embedding (768-dim)
  const embedding = Array(768).fill(0.1);
  await db.query(`
    CREATE issue:inspect2 CONTENT {
      github_node_id: 'I_inspect2',
      github_url: 'https://github.com/testorg/testrepo/issues/2',
      repo: repo:inspectrepo,
      number: 2,
      title: 'Second Issue',
      body: 'Another body',
      state: 'CLOSED',
      state_reason: NONE,
      author: NONE,
      closed_at: time::now(),
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE,
      content_hash: 'abc123',
      embedding: $embedding
    }
  `, { embedding });

  // pull_request 1
  await db.query(`
    CREATE pull_request:inspectpr CONTENT {
      github_node_id: 'PR_inspect1',
      github_url: 'https://github.com/testorg/testrepo/pull/10',
      repo: repo:inspectrepo,
      number: 10,
      title: 'First PR',
      body: NONE,
      state: 'OPEN',
      author: NONE,
      merged_at: NONE,
      closed_at: NONE,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE,
      content_hash: NONE,
      embedding: NONE
    }
  `);

  // label
  await db.query(`
    CREATE label:inspectlabel CONTENT {
      github_node_id: 'LB_inspect1',
      repo: repo:inspectrepo,
      name: 'bug',
      color: 'd73a4a',
      description: NONE,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }
  `);

  // has_label edge: issue1 → label
  const issue1Ref = new StringRecordId(String(issue1Rows[0].id));
  await db.query(
    "RELATE $from->has_label->label:inspectlabel CONTENT { created_at: time::now() }",
    { from: issue1Ref },
  );

  // comment (parent_issue = issue:inspect1)
  await db.query(`
    CREATE comment:inspectcomment CONTENT {
      github_node_id: 'C_inspect1',
      github_url: 'https://github.com/testorg/testrepo/issues/1#issuecomment-1',
      parent_issue: issue:inspect1,
      parent_pr: NONE,
      parent_discussion: NONE,
      parent_comment: NONE,
      author: NONE,
      body: 'A comment',
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE,
      content_hash: NONE,
      embedding: NONE
    }
  `);

  // dangling_reference targeting this repo (dangling_incoming)
  await db.query(`
    CREATE dangling_reference CONTENT {
      parent: issue:inspect1,
      target_owner: 'testorg',
      target_repo: 'testrepo',
      target_number: 99,
      ref_kind: 'references_ref',
      detected_at: time::now()
    }
  `);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("inspect command", () => {
  it("--json on seeded repo returns correct snapshot shape", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedInspect(db);

      const output = await captureLog(() => run(["testorg/testrepo", "--json"]));

      const result = JSON.parse(output) as {
        repo_meta: { name_with_owner: string };
        node_counts: { issue: { total: number }; pull_request: { total: number } };
        embed_coverage: { issue: { percent: number } };
        dangling_sample: unknown[];
        closes_summary: { closes_outgoing: number; dangling_outgoing: number; dangling_incoming: number };
      };

      expect(result.repo_meta.name_with_owner).toBe("testorg/testrepo");
      expect(result.node_counts.issue.total).toBe(2);
      expect(result.node_counts.pull_request.total).toBe(1);
      expect(typeof result.embed_coverage.issue.percent).toBe("number");
      expect(isNaN(result.embed_coverage.issue.percent)).toBe(false);
      expect(result.embed_coverage.issue.percent).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.dangling_sample)).toBe(true);
    });
  });

  it("no args exits 1 with usage error", async () => {
    await withTestDb(async (db) => {
      _testDb = db;

      const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
        throw new Error("process.exit");
      });

      let errorOutput = "";
      try {
        errorOutput = await captureError(() => run([]));
      } catch {
        // process.exit throws
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorOutput).toContain("Usage");

      exitSpy.mockRestore();
    });
  });

  it("unregistered repo arg exits 1 with not found message", async () => {
    await withTestDb(async (db) => {
      _testDb = db;

      const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
        throw new Error("process.exit");
      });

      let errorOutput = "";
      try {
        errorOutput = await captureError(() => run(["nobody/norepo"]));
      } catch {
        // process.exit throws
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorOutput).toContain("not found");

      exitSpy.mockRestore();
    });
  });

  it("human output shows labeled sections and Warning for 0% coverage", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedInspect(db);

      const output = await captureLog(() => run(["testorg/testrepo"]));

      expect(output).toContain("== testorg/testrepo ==");
      expect(output).toContain("-- Node counts --");
      expect(output).toContain("-- Embed coverage --");
      expect(output).toContain("-- Closes summary --");
      // No embeddings set for PR/comment, so expect warning
      expect(output).toContain("! Warning");
    });
  });
});

async function seedSecondRepo(db: Surreal): Promise<void> {
  await db.query(`
    CREATE org:inspectorg2 CONTENT {
      github_node_id: 'U_inspect2',
      github_url: 'https://github.com/testorg2',
      login: 'testorg2',
      name: 'Test Org 2',
      kind: 'Organization',
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }
  `);
  await db.query(`
    CREATE repo:inspectrepo2 CONTENT {
      github_node_id: 'R_inspect2',
      github_url: 'https://github.com/testorg2/testrepo2',
      owner: org:inspectorg2,
      name: 'testrepo2',
      name_with_owner: 'testorg2/testrepo2',
      description: NONE,
      is_private: false,
      registered_at: time::now(),
      last_synced_at: NONE,
      created_at: time::now(),
      updated_at: time::now()
    }
  `);
}

describe("inspect command — --all flag", () => {
  it("human mode outputs ==> headers for both repos separated by a blank line", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedInspect(db);
      await seedSecondRepo(db);

      const output = await captureLog(() => run(["--all"]));

      expect(output).toContain("==> testorg/testrepo");
      expect(output).toContain("==> testorg2/testrepo2");

      // Blank line must appear between the two ==> headers
      const lines = output.split("\n");
      const idx1 = lines.findIndex((l) => l === "==> testorg/testrepo");
      const idx2 = lines.findIndex((l) => l === "==> testorg2/testrepo2");
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx2).toBeGreaterThan(idx1);
      const between = lines.slice(idx1 + 1, idx2);
      expect(between.some((l) => l === "")).toBe(true);
    });
  });

  it("--json mode outputs a JSON array of length 2 with name_with_owner on each element", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      await seedInspect(db);
      await seedSecondRepo(db);

      const output = await captureLog(() => run(["--all", "--json"]));

      const arr = JSON.parse(output) as Array<{ name_with_owner: string }>;
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.length).toBe(2);
      const nwos = arr.map((r) => r.name_with_owner).sort();
      expect(nwos).toEqual(["testorg/testrepo", "testorg2/testrepo2"]);
    });
  });
});

describe("inspect command — --all empty repos", () => {
  it("prints friendly message and exits 0 when no repos are registered", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _withDbCallCount = 0;
      _withDbFailOnCall = null;

      const output = await captureLog(() => run(["--all"]));

      expect(output).toContain("no repos registered");
    });
  });
});

describe("inspect command — --all error isolation", () => {
  it("logs ✗ for failing repo, continues to next, exits 0", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _withDbCallCount = 0;
      // call 1: initial repos list query; call 2: first repo's buildSnapshot → fails
      _withDbFailOnCall = 2;

      await seedInspect(db);
      await seedSecondRepo(db);

      const errors: string[] = [];
      const logs: string[] = [];
      const origErr = console.error;
      const origLog = console.log;
      console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
      console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };

      try {
        await run(["--all"]);
      } finally {
        console.error = origErr;
        console.log = origLog;
        _withDbFailOnCall = null;
      }

      // Error logged for the first repo (testorg/testrepo, alphabetically first)
      expect(errors.some(l => l.includes("✗") && l.includes("testorg/testrepo"))).toBe(true);
      // Second repo still rendered (its header was printed before failure)
      expect(logs.some(l => l.includes("testorg2/testrepo2"))).toBe(true);
    });
  });
});
