import { describe, it, expect, mock } from "bun:test";
import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";
import { createContent } from "../clients/surreal_helpers.ts";

let testDb: Surreal | null = null;
let embedImpl: () => Promise<number[]> = async () => VEC_QUERY.slice();

mock.module("../clients/ollama.ts", () => ({
  embed: (_text: string) => embedImpl(),
  embedMany: (texts: string[]) => Promise.all(texts.map(() => embedImpl())),
}));

mock.module("../clients/surreal.ts", () => ({
  withDb: (fn: (db: Surreal) => Promise<unknown>) => fn(testDb!),
}));

const { default: run } = await import("./search.ts");

const VEC_QUERY = new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));
const VEC_HIGH = new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));
const VEC_MED = new Array(768).fill(0).map((_, i) => (i === 0 ? 0.9 : i === 1 ? 0.1 : 0));
const VEC_LOW = new Array(768).fill(0).map((_, i) => (i === 1 ? 1 : 0));

type RunResult = { exitCode: number | undefined; stdout: string; stderr: string };

async function runCapturing(fn: () => Promise<void>): Promise<RunResult> {
  const origExit = process.exit;
  const origLog = console.log;
  const origError = console.error;
  let exitCode: number | undefined;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  (process as any).exit = (code?: number) => {
    exitCode = code;
    throw new Error(`__exit__${code}`);
  };
  console.log = (...args: any[]) => stdoutLines.push(args.map(String).join(" "));
  console.error = (...args: any[]) => stderrLines.push(args.map(String).join(" "));

  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit__"))) {
      (process as any).exit = origExit;
      console.log = origLog;
      console.error = origError;
      throw e;
    }
  } finally {
    (process as any).exit = origExit;
    console.log = origLog;
    console.error = origError;
  }

  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n") };
}

async function seedRepo(
  db: Surreal,
  suffix: string,
): Promise<{ repoId: unknown; repoRef: StringRecordId; nwo: string }> {
  const [orgRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE org CONTENT {
      github_node_id: $gid,
      github_url: 'https://github.com/testorg',
      login: $login,
      name: NONE,
      kind: 'Organization',
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    { gid: `ORG_${suffix}`, login: `testorg_${suffix}` },
  );
  const orgId = orgRows[0].id;

  const nwo = `testorg_${suffix}/test-repo`;
  const [repoRows] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE repo CONTENT {
      github_node_id: $gid,
      github_url: $url,
      name: 'test-repo',
      name_with_owner: $nwo,
      description: NONE,
      is_private: false,
      owner: $owner,
      created_at: time::now(),
      updated_at: time::now(),
      registered_at: time::now()
    }`,
    { gid: `REPO_${suffix}`, nwo, url: `https://github.com/${nwo}`, owner: orgId },
  );
  const repoId = repoRows[0].id;
  return { repoId, repoRef: new StringRecordId(String(repoId)), nwo };
}

async function seedIssue(
  db: Surreal,
  repoRef: StringRecordId,
  suffix: string,
  opts: { number: number; title: string; embedding: number[] | null },
) {
  const content = createContent({
    github_node_id: `I_${suffix}`,
    github_url: `https://github.com/owner/repo/issues/${opts.number}`,
    repo: repoRef,
    number: opts.number,
    title: opts.title,
    body: "body",
    state: "OPEN",
    author: null,
    deleted_at: null,
    content_hash: `hash_${suffix}`,
    embedding: opts.embedding,
    embedded_content_hash: null,
  });
  await db.query(
    `CREATE issue CONTENT ${content.sql.slice(0, -2)}, created_at: time::now(), updated_at: time::now() }`,
    content.params,
  );
}

describe("search command — happy path, single repo", () => {
  it("returns results sorted by cosine similarity", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const { repoRef } = await seedRepo(db, "HP");
      await seedIssue(db, repoRef, "HP_3", { number: 3, title: "Issue High", embedding: VEC_HIGH.slice() });
      await seedIssue(db, repoRef, "HP_7", { number: 7, title: "Issue Med", embedding: VEC_MED.slice() });
      await seedIssue(db, repoRef, "HP_1", { number: 1, title: "Issue Low", embedding: VEC_LOW.slice() });

      const result = await runCapturing(() => run(["test query", "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout) as Array<{ number: number }>;
      expect(parsed[0].number).toBe(3);
      expect(parsed[1].number).toBe(7);
    });
    testDb = null;
  });
});

describe("search command — JSON output", () => {
  it("emits parseable JSON array with required keys", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const { repoRef, nwo } = await seedRepo(db, "JS");
      await seedIssue(db, repoRef, "JS_1", { number: 1, title: "JS Issue", embedding: VEC_HIGH.slice() });
      await seedIssue(db, repoRef, "JS_2", { number: 2, title: "JS Issue 2", embedding: VEC_MED.slice() });

      const result = await runCapturing(() => run(["test query", "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      expect(Array.isArray(parsed)).toBe(true);
      for (const obj of parsed) {
        expect(obj).toHaveProperty("kind");
        expect(obj).toHaveProperty("repo");
        expect(obj).toHaveProperty("number");
        expect(obj).toHaveProperty("title");
        expect(obj).toHaveProperty("url");
        expect(obj).toHaveProperty("score");
        expect(obj.repo).toBe(nwo);
      }
    });
    testDb = null;
  });
});

describe("search command — --repo scope", () => {
  it("scopes results to the specified repo", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const { repoRef: refA, nwo: nwoA } = await seedRepo(db, "SCA");
      const { repoRef: refB } = await seedRepo(db, "SCB");

      await seedIssue(db, refA, "SCA_1", { number: 1, title: "Repo A Issue 1", embedding: VEC_HIGH.slice() });
      await seedIssue(db, refA, "SCA_2", { number: 2, title: "Repo A Issue 2", embedding: VEC_MED.slice() });
      await seedIssue(db, refB, "SCB_1", { number: 1, title: "Repo B Issue 1", embedding: VEC_HIGH.slice() });

      const result = await runCapturing(() => run(["test query", "--repo", nwoA, "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout) as Array<{ repo: string }>;
      expect(parsed.length).toBeGreaterThan(0);
      for (const obj of parsed) {
        expect(obj.repo).toBe(nwoA);
      }
    });
    testDb = null;
  });
});

describe("search command — --kind issue", () => {
  it("excludes pull_request results when --kind issue", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const { repoRef } = await seedRepo(db, "KI");
      await seedIssue(db, repoRef, "KI_1", { number: 1, title: "KI Issue", embedding: VEC_HIGH.slice() });

      await db.query(
        `CREATE pull_request CONTENT {
          github_node_id: 'PR_KI_1',
          github_url: 'https://github.com/owner/repo/pull/1',
          repo: $repo,
          number: 1,
          title: 'KI Pull Request',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          closed_at: NONE,
          merged_at: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash_pr_ki',
          embedding: $embedding,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef, embedding: VEC_MED.slice() },
      );

      const result = await runCapturing(() => run(["test query", "--kind", "issue", "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout) as Array<{ kind: string }>;
      expect(parsed.every((r) => r.kind === "issue")).toBe(true);
      expect(parsed.some((r) => r.kind === "pull_request")).toBe(false);
    });
    testDb = null;
  });
});

describe("search command — --limit", () => {
  it("returns exactly --limit results", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const { repoRef } = await seedRepo(db, "LM");
      for (let i = 1; i <= 5; i++) {
        await seedIssue(db, repoRef, `LM_${i}`, {
          number: i,
          title: `Limit Issue ${i}`,
          embedding: VEC_HIGH.slice(),
        });
      }

      const result = await runCapturing(() => run(["test query", "--limit", "1", "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout) as unknown[];
      expect(parsed).toHaveLength(1);
    });
    testDb = null;
  });
});

describe("search command — empty matches", () => {
  it("prints friendly hint in human mode when no embeddings", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      await seedRepo(db, "EM");

      const result = await runCapturing(() => run(["test query"]));
      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain("no matches");
    });
    testDb = null;
  });

  it("returns [] in JSON mode when no embeddings", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      await seedRepo(db, "EMJ");

      const result = await runCapturing(() => run(["test query", "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual([]);
    });
    testDb = null;
  });
});

describe("search command — unregistered repo", () => {
  it("exits 1 with error when --repo is not registered", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const result = await runCapturing(() => run(["test query", "--repo", "nobody/nope"]));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not registered");
    });
    testDb = null;
  });
});

describe("search command — Ollama unreachable", () => {
  it("exits non-zero with ✗ Ollama message when embed throws", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => {
        throw new Error("connection refused");
      };

      await seedRepo(db, "OE");
      await seedIssue(db, (await seedRepo(db, "OE2")).repoRef, "OE2_1", {
        number: 1,
        title: "Issue",
        embedding: VEC_HIGH.slice(),
      });

      // Seed a proper repo so we get past the repo check and hit embed
      const { repoRef, nwo } = await seedRepo(db, "OE3");
      await seedIssue(db, repoRef, "OE3_1", { number: 1, title: "Issue", embedding: VEC_HIGH.slice() });

      const result = await runCapturing(() => run(["test query"]));
      expect(result.exitCode).not.toBeUndefined();
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("✗");
      expect(result.stderr).toContain("Ollama");
    });
    testDb = null;
  });
});

describe("search command — bot items absent", () => {
  it("does not return bot-authored issues with no embedding", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const { repoRef } = await seedRepo(db, "BA");

      const [userRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE user CONTENT {
          github_node_id: 'BOT_BA_1',
          github_url: 'https://github.com/bot',
          login: 'bot-user',
          name: NONE,
          is_bot: true,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const botRef = new StringRecordId(String(userRows[0].id));

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_BA_BOT',
          github_url: 'https://github.com/owner/repo/issues/2',
          repo: $repo,
          number: 2,
          title: 'Bot Issue',
          body: 'body',
          state: 'OPEN',
          author: $author,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash_bot',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef, author: botRef },
      );

      await seedIssue(db, repoRef, "BA_1", {
        number: 1,
        title: "Human Issue",
        embedding: VEC_HIGH.slice(),
      });

      const result = await runCapturing(() => run(["test query", "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout) as Array<{ number: number; title: string }>;
      expect(parsed.some((r) => r.title === "Bot Issue")).toBe(false);
      expect(parsed.some((r) => r.title === "Human Issue")).toBe(true);
    });
    testDb = null;
  });
});

describe("search command — comment in results", () => {
  it("returns comment with correct kind, subkind, title, and url", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedImpl = async () => VEC_QUERY.slice();

      const { repoRef } = await seedRepo(db, "CM");

      const [issueRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE issue CONTENT {
          github_node_id: 'I_CM_1',
          github_url: 'https://github.com/owner/repo/issues/42',
          repo: $repo,
          number: 42,
          title: 'Parent Issue Title',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash_cm_i',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );
      const issueRef = new StringRecordId(String(issueRows[0].id));

      const commentUrl = "https://github.com/owner/repo/issues/42#issuecomment-999";
      await db.query(
        `CREATE comment CONTENT {
          github_node_id: 'C_CM_1',
          github_url: $url,
          parent_issue: $parentIssue,
          parent_pr: NONE,
          parent_discussion: NONE,
          parent_comment: NONE,
          author: NONE,
          body: 'A test comment body',
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash_cm_c',
          embedding: $embedding,
          embedded_content_hash: 'hash_cm_c'
        }`,
        { url: commentUrl, parentIssue: issueRef, embedding: VEC_MED.slice() },
      );

      const result = await runCapturing(() => run(["test query", "--json"]));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      const commentResult = parsed.find((r) => r.kind === "comment");
      expect(commentResult).toBeDefined();
      expect(commentResult!.subkind).toBe("issue");
      expect(String(commentResult!.title)).toContain("Parent Issue Title");
      expect(commentResult!.url).toBe(commentUrl);
    });
    testDb = null;
  });
});
