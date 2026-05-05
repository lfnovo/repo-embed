import { withDb } from "../clients/surreal.ts";
import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";

function formatDate(dt: unknown): string {
  if (dt == null) return "(never)";
  const date = dt instanceof Date ? dt : new Date(String(dt));
  if (isNaN(date.getTime())) return "(never)";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

interface NodeCount {
  total: number;
  tombstoned: number;
}

interface EmbedCoverage {
  total: number;
  bot_authored: number;
  eligible: number;
  embedded: number;
  percent: number;
}

interface TopReferenced {
  id: string;
  number: number;
  title: string;
  ref_count: number;
}

interface ClosesSummary {
  closes_outgoing: number;
  dangling_outgoing: number;
  dangling_incoming: number;
}

interface DanglingSample {
  target_owner: string;
  target_repo: string;
  target_number: number;
  ref_kind: string;
}

interface RecentUpdate {
  kind: string;
  number: number | null;
  title: string;
  updated_at: unknown;
}

interface Snapshot {
  repo_meta: { name_with_owner: string; registered_at: unknown; last_synced_at: unknown };
  node_counts: Record<string, NodeCount>;
  embed_coverage: Record<string, EmbedCoverage>;
  top_referenced: TopReferenced[];
  closes_summary: ClosesSummary;
  dangling_sample: DanglingSample[];
  recent_updates: RecentUpdate[];
}

type CommentRow = {
  id: unknown;
  parent_issue: unknown;
  parent_pr: unknown;
  parent_discussion: unknown;
  deleted_at: unknown;
  embedding: unknown;
  author: unknown;
  updated_at: unknown;
};

async function fetchRows<T>(
  db: Surreal,
  query: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const [result] = await db.query<[T[]]>(query, params ?? {});
  return result;
}

async function buildSnapshot(
  db: Surreal,
  repoRow: { id: unknown; name_with_owner: string; registered_at: unknown; last_synced_at: unknown },
  owner: string,
  name: string,
): Promise<Snapshot> {
  const repoRef = new StringRecordId(String(repoRow.id));

  // Collect entity IDs for this repo — used to scope comments without dot traversal
  const issueIdRows = await fetchRows<{ id: unknown }>(
    db, "SELECT id FROM issue WHERE repo = $repoRef", { repoRef },
  );
  const prIdRows = await fetchRows<{ id: unknown }>(
    db, "SELECT id FROM pull_request WHERE repo = $repoRef", { repoRef },
  );
  const discIdRows = await fetchRows<{ id: unknown }>(
    db, "SELECT id FROM discussion WHERE repo = $repoRef", { repoRef },
  );

  const issueIds = new Set(issueIdRows.map((r) => String(r.id)));
  const prIds = new Set(prIdRows.map((r) => String(r.id)));
  const discIds = new Set(discIdRows.map((r) => String(r.id)));
  const allEntityIds = new Set([...issueIds, ...prIds, ...discIds]);

  // Fetch all comments once; filter in JS to avoid WASM dot-traversal limitations
  const allComments = await fetchRows<CommentRow>(
    db,
    "SELECT id, parent_issue, parent_pr, parent_discussion, deleted_at, embedding, author, updated_at FROM comment",
  );
  const repoComments = allComments.filter(
    (c) =>
      (c.parent_issue && issueIds.has(String(c.parent_issue))) ||
      (c.parent_pr && prIds.has(String(c.parent_pr))) ||
      (c.parent_discussion && discIds.has(String(c.parent_discussion))),
  );

  // ── Node counts ────────────────────────────────────────────────────────────
  const node_counts: Record<string, NodeCount> = {};

  for (const type of ["issue", "pull_request", "discussion", "commit", "label"] as const) {
    const all = await fetchRows<unknown>(
      db, `SELECT id FROM ${type} WHERE repo = $repoRef`, { repoRef },
    );
    const tombstoned = await fetchRows<unknown>(
      db, `SELECT id FROM ${type} WHERE repo = $repoRef AND deleted_at != NONE`, { repoRef },
    );
    node_counts[type] = { total: all.length, tombstoned: tombstoned.length };
  }

  node_counts["comment"] = {
    total: repoComments.length,
    tombstoned: repoComments.filter((c) => c.deleted_at != null).length,
  };

  // ── Embed coverage ─────────────────────────────────────────────────────────
  const embed_coverage: Record<string, EmbedCoverage> = {};

  for (const type of ["issue", "pull_request", "discussion"] as const) {
    const rows = await fetchRows<{ author: unknown; embedding: unknown }>(
      db,
      `SELECT author, embedding FROM ${type} WHERE repo = $repoRef AND deleted_at = NONE`,
      { repoRef },
    );
    const total = rows.length;
    let bot_authored = 0;
    try {
      // Try dot traversal; may fail in WASM
      const botRows = await fetchRows<unknown>(
        db,
        `SELECT id FROM ${type} WHERE repo = $repoRef AND deleted_at = NONE AND author.is_bot = true`,
        { repoRef },
      );
      bot_authored = botRows.length;
    } catch {
      bot_authored = rows.filter((r) => (r.author as Record<string, unknown>)?.is_bot === true).length;
    }
    const eligible = total - bot_authored;
    const embedded = rows.filter(
      (r) => r.embedding != null && (r.author as Record<string, unknown>)?.is_bot !== true,
    ).length;
    const percent = eligible > 0 ? Math.round((embedded / eligible) * 100) : 0;
    embed_coverage[type] = { total, bot_authored, eligible, embedded, percent };
  }

  {
    const nonTombstoned = repoComments.filter((c) => c.deleted_at == null);
    const total = nonTombstoned.length;
    const bot_authored = nonTombstoned.filter(
      (c) => (c.author as Record<string, unknown>)?.is_bot === true,
    ).length;
    const eligible = total - bot_authored;
    const embedded = nonTombstoned.filter(
      (c) => c.embedding != null && (c.author as Record<string, unknown>)?.is_bot !== true,
    ).length;
    const percent = eligible > 0 ? Math.round((embedded / eligible) * 100) : 0;
    embed_coverage["comment"] = { total, bot_authored, eligible, embedded, percent };
  }

  // ── Top referenced ─────────────────────────────────────────────────────────
  let top_referenced: TopReferenced[] = [];
  try {
    const topRows = await fetchRows<{
      id: unknown;
      number: number;
      title: string;
      ref_count: number;
    }>(
      db,
      `SELECT id, number, title, array::len(<-references_ref) AS ref_count
       FROM issue, pull_request
       WHERE repo = $repoRef AND deleted_at = NONE
       ORDER BY ref_count DESC LIMIT 5`,
      { repoRef },
    );
    top_referenced = topRows.map((r) => ({
      id: String(r.id),
      number: r.number,
      title: r.title,
      ref_count: r.ref_count ?? 0,
    }));
  } catch {
    // Fallback: count edges per node individually
    const allNodes = await fetchRows<{ id: unknown; number: number; title: string }>(
      db,
      `SELECT id, number, title FROM issue, pull_request WHERE repo = $repoRef AND deleted_at = NONE`,
      { repoRef },
    );
    const withCounts = await Promise.all(
      allNodes.map(async (node) => {
        const nodeRef = new StringRecordId(String(node.id));
        const edgeRows = await fetchRows<unknown>(
          db, "SELECT id FROM references_ref WHERE out = $nodeRef", { nodeRef },
        );
        return { id: String(node.id), number: node.number, title: node.title, ref_count: edgeRows.length };
      }),
    );
    top_referenced = withCounts.sort((a, b) => b.ref_count - a.ref_count).slice(0, 5);
  }

  // ── Closes summary ─────────────────────────────────────────────────────────
  let closes_outgoing = 0;
  try {
    const closeRows = await fetchRows<unknown>(
      db, "SELECT id FROM closes WHERE in.repo = $repoRef", { repoRef },
    );
    closes_outgoing = closeRows.length;
  } catch {
    // Fallback: count per PR
    for (const prId of prIds) {
      const prRef = new StringRecordId(prId);
      const edgeRows = await fetchRows<unknown>(
        db, "SELECT id FROM closes WHERE in = $prRef", { prRef },
      );
      closes_outgoing += edgeRows.length;
    }
  }

  let dangling_outgoing = 0;
  try {
    const danglingRows = await fetchRows<unknown>(
      db, "SELECT id FROM dangling_reference WHERE parent.repo = $repoRef", { repoRef },
    );
    dangling_outgoing = danglingRows.length;
  } catch {
    // Fallback: filter all dangling rows by parent membership in JS
    const allDangling = await fetchRows<{ parent: unknown }>(
      db, "SELECT parent FROM dangling_reference",
    );
    dangling_outgoing = allDangling.filter((r) => allEntityIds.has(String(r.parent))).length;
  }

  const danglingIncomingRows = await fetchRows<unknown>(
    db,
    "SELECT id FROM dangling_reference WHERE target_owner = $owner AND target_repo = $name",
    { owner, name },
  );
  const dangling_incoming = danglingIncomingRows.length;

  // ── Dangling sample ────────────────────────────────────────────────────────
  const dangling_sample = await fetchRows<DanglingSample>(
    db,
    "SELECT target_owner, target_repo, target_number, ref_kind FROM dangling_reference WHERE target_owner = $owner AND target_repo = $name LIMIT 5",
    { owner, name },
  );

  // ── Recent updates ─────────────────────────────────────────────────────────
  const allUpdates: RecentUpdate[] = [];

  for (const kind of ["issue", "pull_request", "discussion"] as const) {
    const rows = await fetchRows<{ number: number; title: string; updated_at: unknown }>(
      db,
      `SELECT number, title, updated_at FROM ${kind} WHERE repo = $repoRef AND deleted_at = NONE ORDER BY updated_at DESC LIMIT 5`,
      { repoRef },
    );
    for (const r of rows) {
      allUpdates.push({ kind, number: r.number, title: r.title, updated_at: r.updated_at });
    }
  }

  // Use already-fetched repoComments for recent comment updates
  const recentComments = repoComments
    .filter((c) => c.deleted_at == null)
    .sort((a, b) => {
      const aTime = a.updated_at ? new Date(String(a.updated_at)).getTime() : 0;
      const bTime = b.updated_at ? new Date(String(b.updated_at)).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 5);
  for (const c of recentComments) {
    allUpdates.push({ kind: "comment", number: null, title: String(c.id), updated_at: c.updated_at });
  }

  const recent_updates = allUpdates
    .sort((a, b) => {
      const aTime = a.updated_at ? new Date(String(a.updated_at)).getTime() : 0;
      const bTime = b.updated_at ? new Date(String(b.updated_at)).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 5);

  return {
    repo_meta: {
      name_with_owner: repoRow.name_with_owner,
      registered_at: repoRow.registered_at,
      last_synced_at: repoRow.last_synced_at,
    },
    node_counts,
    embed_coverage,
    top_referenced,
    closes_summary: { closes_outgoing, dangling_outgoing, dangling_incoming },
    dangling_sample,
    recent_updates,
  };
}

function renderHuman(snapshot: Snapshot, nwo: string): void {
  const { repo_meta, node_counts, embed_coverage, top_referenced, closes_summary, dangling_sample, recent_updates } = snapshot;

  console.log(`\n== ${repo_meta.name_with_owner} ==`);
  console.log(
    `Registered: ${formatDate(repo_meta.registered_at)}  Last synced: ${formatDate(repo_meta.last_synced_at)}`,
  );

  if (repo_meta.last_synced_at == null) {
    console.log(`! (repo has not been synced — run \`tool sync ${nwo}\`)`);
  }

  console.log("\n-- Node counts --");
  for (const type of ["issue", "pull_request", "discussion", "comment", "commit", "label"]) {
    const nc = node_counts[type];
    console.log(`  ${type.padEnd(14)}: ${nc.total} total, ${nc.tombstoned} tombstoned`);
  }

  console.log("\n-- Embed coverage --");
  let allZero = true;
  for (const type of ["issue", "pull_request", "discussion", "comment"]) {
    const ec = embed_coverage[type];
    console.log(`  ${type.padEnd(14)}: eligible=${ec.eligible}  embedded=${ec.embedded}  (${ec.percent}%)`);
    if (ec.percent === 0 && ec.eligible > 0) {
      console.log(`  ! Warning: ${type} has 0% embed coverage`);
    }
    if (ec.percent > 0) allZero = false;
  }
  if (allZero && repo_meta.last_synced_at != null) {
    console.log(`! (no embeddings yet — run \`tool embed ${nwo}\`)`);
  }

  console.log("\n-- Top referenced --");
  if (top_referenced.length === 0) {
    console.log("  (none)");
  } else {
    for (const ref of top_referenced) {
      console.log(`  #${ref.number} ${ref.title} (${ref.ref_count} refs)`);
    }
  }

  console.log("\n-- Closes summary --");
  console.log(
    `  closes_outgoing: ${closes_summary.closes_outgoing}  dangling_outgoing: ${closes_summary.dangling_outgoing}  dangling_incoming: ${closes_summary.dangling_incoming}`,
  );

  console.log("\n-- Dangling sample --");
  if (dangling_sample.length === 0) {
    console.log("  (none)");
  } else {
    for (const d of dangling_sample) {
      console.log(`  ${d.target_owner}/${d.target_repo}#${d.target_number} (${d.ref_kind})`);
    }
  }

  console.log("\n-- Recent updates --");
  if (recent_updates.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of recent_updates) {
      const label = r.number != null ? `#${r.number} ${r.title}` : r.title;
      console.log(`  [${r.kind}] ${label} — ${formatDate(r.updated_at)}`);
    }
  }
}

type RepoListRow = {
  id: unknown;
  name_with_owner: string;
  registered_at: unknown;
  last_synced_at: unknown;
};

export default async function run(args: string[]): Promise<void> {
  const allFlag = args.includes("--all");
  const nwo = args.find((a) => !a.startsWith("--"));
  const json = args.includes("--json");

  if (allFlag) {
    let repos: RepoListRow[] = [];
    await withDb(async (db) => {
      const [rows] = await db.query<[RepoListRow[]]>(
        "SELECT id, name_with_owner, registered_at, last_synced_at FROM repo WHERE registered_at IS NOT NONE ORDER BY name_with_owner",
      );
      repos = rows;
    });

    if (json) {
      const snapshots: (Snapshot & { name_with_owner: string })[] = [];
      for (const repo of repos) {
        const [owner, name] = repo.name_with_owner.split("/");
        await withDb(async (db) => {
          const snapshot = await buildSnapshot(db, repo, owner, name);
          snapshots.push({ ...snapshot, name_with_owner: repo.name_with_owner });
        });
      }
      console.log(JSON.stringify(snapshots));
      return;
    }

    let first = true;
    for (const repo of repos) {
      if (!first) console.log("");
      first = false;
      console.log(`==> ${repo.name_with_owner}`);
      const [owner, name] = repo.name_with_owner.split("/");
      await withDb(async (db) => {
        const snapshot = await buildSnapshot(db, repo, owner, name);
        renderHuman(snapshot, repo.name_with_owner);
      });
    }
    return;
  }

  if (!nwo || !nwo.includes("/")) {
    console.error("✗ Usage: tool inspect <owner/name> [--json]");
    process.exit(1);
  }

  const [owner, name] = nwo.split("/");

  await withDb(async (db) => {
    const [repoRows] = await db.query<[RepoListRow[]]>(
      "SELECT id, name_with_owner, registered_at, last_synced_at FROM repo WHERE name_with_owner = $nwo AND registered_at != NONE",
      { nwo },
    );

    if (repoRows.length === 0) {
      console.error(
        `✗ Repo '${nwo}' not found — register it first with \`tool add <owner/name>\``,
      );
      process.exit(1);
    }

    const snapshot = await buildSnapshot(db, repoRows[0], owner, name);

    if (json) {
      console.log(JSON.stringify(snapshot));
      return;
    }

    renderHuman(snapshot, nwo);
  });
}
