import { describe, it, expect, mock } from "bun:test";
import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import { withTestDb } from "../test_utils/with_test_db.ts";

let testDb: Surreal | null = null;
let embedManyCallCount = 0;
let embedManyImpl: (texts: string[]) => Promise<number[][]> = async (texts) =>
  texts.map(() => new Array(768).fill(0.1));
let embedProbeImpl: () => Promise<number[]> = async () => new Array(768).fill(0.1);
let embedWithFallbackImpl: (text: string) => Promise<number[]> = async () =>
  new Array(768).fill(0.1);

mock.module("../clients/ollama.ts", () => ({
  embed: (_text: string) => embedProbeImpl(),
  embedMany: (texts: string[]) => {
    embedManyCallCount++;
    return embedManyImpl(texts);
  },
  embedWithFallback: (text: string) => embedWithFallbackImpl(text),
}));

mock.module("../clients/surreal.ts", () => ({
  withDb: (fn: (db: Surreal) => Promise<unknown>) => fn(testDb!),
}));

const { default: run } = await import("./embed.ts");

async function runCapturingExit(
  fn: () => Promise<void>,
): Promise<{ exitCode: number | undefined }> {
  const orig = process.exit;
  let exitCode: number | undefined;
  (process as any).exit = (code?: number) => {
    exitCode = code;
    throw new Error(`__exit__${code}`);
  };
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit__"))) {
      (process as any).exit = orig;
      throw e;
    }
  } finally {
    (process as any).exit = orig;
  }
  return { exitCode };
}

async function seedRepoAndOrg(db: Surreal, suffix: string) {
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
      github_url: 'https://github.com/testorg/test-repo',
      name: 'test-repo',
      name_with_owner: $nwo,
      description: NONE,
      is_private: false,
      owner: $owner,
      created_at: time::now(),
      updated_at: time::now(),
      registered_at: time::now()
    }`,
    { gid: `REPO_${suffix}`, nwo, owner: orgId },
  );
  return { orgId, repoId: repoRows[0].id, nwo };
}

describe("embed command — happy path", () => {
  it("embeds 2 non-bot issues and sets embedding + embedded_content_hash", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      embedManyImpl = async (texts) => texts.map(() => new Array(768).fill(0.5));
      embedProbeImpl = async () => new Array(768).fill(0.1);

      const { repoId, nwo } = await seedRepoAndOrg(db, "HP");
      const repoRef = new StringRecordId(String(repoId));

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_HP_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'Issue 1',
          body: 'Body 1',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash1',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );
      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_HP_2',
          github_url: 'u',
          repo: $repo,
          number: 2,
          title: 'Issue 2',
          body: 'Body 2',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash2',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );

      await run([nwo]);

      const [issues] = await db.query<
        [Array<{ github_node_id: string; embedding: unknown; embedded_content_hash: string }>]
      >("SELECT github_node_id, embedding, embedded_content_hash FROM issue");

      const i1 = issues.find((i) => i.github_node_id === "I_HP_1")!;
      const i2 = issues.find((i) => i.github_node_id === "I_HP_2")!;
      expect(i1.embedding).not.toBeNull();
      expect(i1.embedding).not.toBeUndefined();
      expect(i1.embedded_content_hash).toBe("hash1");
      expect(i2.embedding).not.toBeNull();
      expect(i2.embedding).not.toBeUndefined();
      expect(i2.embedded_content_hash).toBe("hash2");
    });
    testDb = null;
  });
});

describe("embed command — bot skip", () => {
  it("does not embed bot-authored issue", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      embedManyImpl = async (texts) => texts.map(() => new Array(768).fill(0.5));
      embedProbeImpl = async () => new Array(768).fill(0.1);

      const { repoId, nwo } = await seedRepoAndOrg(db, "BS");
      const repoRef = new StringRecordId(String(repoId));

      const [userRows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE user CONTENT {
          github_node_id: 'BOT_BS_1',
          github_url: 'u',
          login: 'bot-user',
          name: NONE,
          is_bot: true,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
      );
      const botId = userRows[0].id;

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_BS_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'Bot Issue',
          body: 'body',
          state: 'OPEN',
          author: $author,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'bhash',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef, author: new StringRecordId(String(botId)) },
      );

      await run([nwo]);

      const [[issue]] = await db.query<[[{ embedding: unknown }]]>(
        "SELECT embedding FROM issue WHERE github_node_id = 'I_BS_1'",
      );
      expect(issue.embedding == null).toBe(true);
    });
    testDb = null;
  });
});

describe("embed command — up-to-date skip", () => {
  it("does not call embedMany for issue with matching embedded_content_hash", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      embedManyImpl = async (texts) => texts.map(() => new Array(768).fill(0.5));
      embedProbeImpl = async () => new Array(768).fill(0.1);

      const { repoId, nwo } = await seedRepoAndOrg(db, "UT");
      const repoRef = new StringRecordId(String(repoId));

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_UT_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'Up-to-date',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'same_hash',
          embedding: $embedding,
          embedded_content_hash: 'same_hash'
        }`,
        { repo: repoRef, embedding: new Array(768).fill(0.5) },
      );

      await run([nwo]);

      expect(embedManyCallCount).toBe(0);
    });
    testDb = null;
  });
});

describe("embed command — re-embed on content change", () => {
  it("re-embeds issue with stale embedded_content_hash", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      embedManyImpl = async (texts) => texts.map(() => new Array(768).fill(0.9));
      embedProbeImpl = async () => new Array(768).fill(0.1);

      const { repoId, nwo } = await seedRepoAndOrg(db, "RE");
      const repoRef = new StringRecordId(String(repoId));

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_RE_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'Stale',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'new_hash',
          embedding: $embedding,
          embedded_content_hash: 'old_hash'
        }`,
        { repo: repoRef, embedding: new Array(768).fill(0.1) },
      );

      await run([nwo]);

      const [[issue]] = await db.query<
        [[{ embedded_content_hash: string; embedding: number[] }]]
      >("SELECT embedded_content_hash, embedding FROM issue WHERE github_node_id = 'I_RE_1'");

      expect(issue.embedded_content_hash).toBe("new_hash");
      expect(issue.embedding).not.toBeNull();
      expect((issue.embedding as number[])[0]).toBeCloseTo(0.9, 5);
    });
    testDb = null;
  });
});

describe("embed command — author-null embeds", () => {
  it("embeds issue with NONE author", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      embedManyImpl = async (texts) => texts.map(() => new Array(768).fill(0.5));
      embedProbeImpl = async () => new Array(768).fill(0.1);

      const { repoId, nwo } = await seedRepoAndOrg(db, "AN");
      const repoRef = new StringRecordId(String(repoId));

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_AN_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'No Author',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash_a',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );

      await run([nwo]);

      const [[issue]] = await db.query<[[{ embedding: unknown }]]>(
        "SELECT embedding FROM issue WHERE github_node_id = 'I_AN_1'",
      );
      expect(issue.embedding).not.toBeNull();
      expect(issue.embedding).not.toBeUndefined();
    });
    testDb = null;
  });
});

describe("embed command — Ollama probe failure", () => {
  it("exits non-zero and writes no embeddings when Ollama is unreachable", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      embedProbeImpl = async () => {
        throw new Error("connection refused");
      };
      embedManyImpl = async (texts) => texts.map(() => new Array(768).fill(0.5));

      const { repoId, nwo } = await seedRepoAndOrg(db, "OF");
      const repoRef = new StringRecordId(String(repoId));

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_OF_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'Issue',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash_p',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );

      const { exitCode } = await runCapturingExit(() => run([nwo]));
      expect(exitCode).toBe(1);
      expect(embedManyCallCount).toBe(0);

      const [[issue]] = await db.query<[[{ embedding: unknown }]]>(
        "SELECT embedding FROM issue WHERE github_node_id = 'I_OF_1'",
      );
      expect(issue.embedding == null).toBe(true);
    });
    testDb = null;
  });
});

describe("embed command — per-item failure after first success", () => {
  it("completes run, embeds first item, logs second as failed, exits non-zero", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      let callIndex = 0;
      embedManyImpl = async (texts) => {
        callIndex++;
        if (callIndex === 1) return texts.map(() => new Array(768).fill(0.5));
        throw new Error("embedding service error");
      };
      embedWithFallbackImpl = async () => {
        throw new Error("embedding service error");
      };
      embedProbeImpl = async () => new Array(768).fill(0.1);

      const { repoId, nwo } = await seedRepoAndOrg(db, "PF");
      const repoRef = new StringRecordId(String(repoId));

      // issue → embedMany call #1 (succeeds)
      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_PF_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'Issue',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'h_issue',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );
      // pull_request → embedMany call #2 (throws)
      await db.query(
        `CREATE pull_request CONTENT {
          github_node_id: 'PR_PF_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'PR',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          closed_at: NONE,
          merged_at: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'h_pr',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );

      const { exitCode } = await runCapturingExit(() => run([nwo]));
      expect(exitCode).toBe(1);

      const [[issue]] = await db.query<
        [[{ embedding: unknown; embedded_content_hash: string }]]
      >(
        "SELECT embedding, embedded_content_hash FROM issue WHERE github_node_id = 'I_PF_1'",
      );
      expect(issue.embedding).not.toBeNull();
      expect(issue.embedded_content_hash).toBe("h_issue");

      const [[pr]] = await db.query<[[{ embedding: unknown }]]>(
        "SELECT embedding FROM pull_request WHERE github_node_id = 'PR_PF_1'",
      );
      expect(pr.embedding == null).toBe(true);
    });
    testDb = null;
  });
});

describe("embed command — per-item oversize recovery", () => {
  it("embeds item via embedWithFallback when batch fails with context-length error", async () => {
    await withTestDb(async (db) => {
      testDb = db;
      embedManyCallCount = 0;
      embedManyImpl = async () => {
        throw new Error("context length exceeded");
      };
      embedWithFallbackImpl = async () => new Array(768).fill(0.7);
      embedProbeImpl = async () => new Array(768).fill(0.1);

      const { repoId, nwo } = await seedRepoAndOrg(db, "OR");
      const repoRef = new StringRecordId(String(repoId));

      await db.query(
        `CREATE issue CONTENT {
          github_node_id: 'I_OR_1',
          github_url: 'u',
          repo: $repo,
          number: 1,
          title: 'Oversize Issue',
          body: 'body',
          state: 'OPEN',
          author: NONE,
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE,
          content_hash: 'hash_or',
          embedding: NONE,
          embedded_content_hash: NONE
        }`,
        { repo: repoRef },
      );

      const { exitCode } = await runCapturingExit(() => run([nwo]));
      expect(exitCode).toBeUndefined();

      const [[issue]] = await db.query<
        [[{ embedding: unknown; embedded_content_hash: string }]]
      >(
        "SELECT embedding, embedded_content_hash FROM issue WHERE github_node_id = 'I_OR_1'",
      );
      expect(issue.embedding).not.toBeNull();
      expect(issue.embedding).not.toBeUndefined();
      expect(issue.embedded_content_hash).toBe("hash_or");
    });
    testDb = null;
  });
});
