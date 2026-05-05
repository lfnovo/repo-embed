import { withDb } from "../clients/surreal.ts";
import { embed, embedMany, embedWithFallback } from "../clients/ollama.ts";
import { embedText } from "../ingest/embed_text.ts";
import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import { config } from "../config.ts";

const BATCH_SIZE = 16;

type EmbedCandidate = {
  id: unknown;
  github_node_id: string;
  title?: string | null;
  body: string | null;
  content_hash: string;
};

async function embedForRepo(db: Surreal, nwo: string): Promise<void> {
  // 1. Load repo
  const [repoRows] = await db.query<
    [Array<{ id: unknown; name_with_owner: string; registered_at: unknown }>]
  >("SELECT id, name_with_owner, registered_at FROM repo WHERE name_with_owner = $nwo", {
    nwo,
  });
  const repoRow = repoRows[0];
  if (!repoRow || repoRow.registered_at == null) {
    throw new Error("repo not registered — use `tool add` first");
  }
  const repoRef = new StringRecordId(String(repoRow.id));

  // 2. Process each kind
  const kinds = ["issue", "pull_request", "discussion", "comment"] as const;
  const labels: Record<string, string> = {
    issue: "Issues",
    pull_request: "PRs",
    discussion: "Discussions",
    comment: "Comments",
  };

  let totalEmbedded = 0;
  let totalFailed = 0;
  let successCount = 0;
  let consecutiveFailsFromStart = 0;

  for (const kind of kinds) {
    let candidates: EmbedCandidate[];

    if (kind === "comment") {
      const [rows] = await db.query<[EmbedCandidate[]]>(
        `SELECT id, github_node_id, body, content_hash FROM comment
         WHERE (parent_issue.repo = $repoRef OR parent_pr.repo = $repoRef OR parent_discussion.repo = $repoRef)
         AND deleted_at IS NONE
         AND content_hash != NONE
         AND (author IS NONE OR author.is_bot != true)
         AND (embedding = NONE OR embedded_content_hash != content_hash)`,
        { repoRef },
      );
      candidates = rows;
    } else {
      const [rows] = await db.query<[EmbedCandidate[]]>(
        `SELECT id, github_node_id, title, body, content_hash FROM ${kind}
         WHERE repo = $repoRef
         AND deleted_at IS NONE
         AND content_hash != NONE
         AND (author IS NONE OR author.is_bot != true)
         AND (embedding = NONE OR embedded_content_hash != content_hash)`,
        { repoRef },
      );
      candidates = rows;
    }

    let embedded = 0;
    let failed = 0;

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const texts = batch.map((item) => embedText({ title: item.title, body: item.body }));

      // Batch path: try the whole batch in one Ollama call.
      // Per-item fallback: if the batch fails (typically because ONE item
      // exceeds context length), retry items individually so the others
      // still embed. Items that fail at size 1 are truly bad and skipped.
      let vectors: (number[] | null)[] = [];
      try {
        vectors = await embedMany(texts);
      } catch {
        // Fall back to per-item embedding to isolate the offender.
        for (let j = 0; j < texts.length; j++) {
          try {
            const single = await embedWithFallback(texts[j]);
            vectors.push(single);
          } catch (perItemErr) {
            if (successCount === 0) {
              consecutiveFailsFromStart++;
              if (consecutiveFailsFromStart >= 3) {
                throw perItemErr;
              }
            }
            console.error(
              `✗ Failed to embed ${kind} ${batch[j].github_node_id}: ${perItemErr}`,
            );
            failed++;
            vectors.push(null);
          }
        }
      }

      // Persist vectors for items that produced one.
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (vector === null) continue;
        const item = batch[j];
        try {
          await db.query(
            "UPDATE $id SET embedding = $vector, embedded_content_hash = $hash",
            {
              id: new StringRecordId(String(item.id)),
              vector,
              hash: item.content_hash,
            },
          );
          successCount++;
          embedded++;
        } catch (updateErr) {
          if (successCount === 0) {
            consecutiveFailsFromStart++;
            if (consecutiveFailsFromStart >= 3) {
              throw updateErr;
            }
          }
          console.error(`✗ Failed to update ${kind} ${item.github_node_id}: ${updateErr}`);
          failed++;
        }
      }
    }

    console.log(`✓ ${labels[kind]}: ${embedded} embedded, ${failed} failed`);
    totalEmbedded += embedded;
    totalFailed += failed;
  }

  console.log(`✓ Total: ${totalEmbedded} embedded, ${totalFailed} failed`);
  if (totalFailed > 0) {
    throw new Error(`embed completed with ${totalFailed} failed item(s)`);
  }
}

export default async function run(args: string[]): Promise<void> {
  const allFlag = args.includes('--all');

  if (allFlag) {
    // Probe Ollama once before the loop; re-throw on failure (infra error)
    try {
      await embed("ping");
    } catch (err) {
      console.error(`✗ Ollama not reachable at ${config.OLLAMA_URL}: ${err}`);
      throw err;
    }

    let repos: Array<{ id: unknown; name_with_owner: string }> = [];
    await withDb(async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown; name_with_owner: string }>]>(
        "SELECT id, name_with_owner FROM repo WHERE registered_at IS NOT NONE ORDER BY name_with_owner",
      );
      repos = rows;
    });

    if (repos.length === 0) {
      console.log("(no repos registered — use `tool add` first)");
      return;
    }

    let succeeded = 0;
    let failed = 0;
    const total = repos.length;

    for (const repo of repos) {
      console.log(`==> ${repo.name_with_owner}`);
      try {
        await withDb(async (db) => {
          await embedForRepo(db, repo.name_with_owner);
        });
        succeeded++;
      } catch (err) {
        console.error(`✗ ${repo.name_with_owner} failed: ${(err as Error).message}`);
        failed++;
      }
    }

    console.log(`✓ Bulk embed: ${succeeded}/${total} succeeded, ${failed} failed`);
    if (failed > 0) process.exit(1);
    return;
  }

  const input = args[0];
  if (!input || !/^[^/]+\/[^/]+$/.test(input)) {
    console.error("✗ Usage: tool embed <owner/name>");
    process.exit(1);
  }

  await withDb(async (db) => {
    // Load repo first so we don't probe Ollama for unregistered repos
    const [repoRows] = await db.query<
      [Array<{ id: unknown; registered_at: unknown }>]
    >("SELECT id, registered_at FROM repo WHERE name_with_owner = $nwo", { nwo: input });
    const repoRow = repoRows[0];
    if (!repoRow || repoRow.registered_at == null) {
      throw new Error("repo not registered — use `tool add` first");
    }

    // Probe Ollama
    try {
      await embed("ping");
    } catch (err) {
      console.error(`✗ Ollama not reachable at ${config.OLLAMA_URL}: ${err}`);
      process.exit(1);
    }

    try {
      await embedForRepo(db, input);
    } catch {
      process.exit(1);
    }
  });
}
