import { withDb } from "../clients/surreal.ts";
import { embed } from "../clients/ollama.ts";
import { StringRecordId } from "surrealdb";

type EntityKind = "issue" | "pull_request" | "discussion";
type SearchKind = EntityKind | "comment";

type EntityResult = {
  kind: EntityKind;
  repo: string;
  number: number;
  title: string;
  url: string;
  score: number;
};

type CommentResult = {
  kind: "comment";
  subkind: EntityKind;
  repo: string;
  number: number;
  title: string;
  url: string;
  score: number;
};

type SearchResult = EntityResult | CommentResult;

export default async function run(args: string[]): Promise<void> {
  const positional: string[] = [];
  let repoArg: string | undefined;
  let jsonFlag = false;
  let kindArg = "all";
  let limitStr: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") {
      repoArg = args[++i];
    } else if (a === "--json") {
      jsonFlag = true;
    } else if (a === "--kind") {
      kindArg = args[++i];
    } else if (a === "--limit") {
      limitStr = args[++i];
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }

  const query = positional[0];
  if (!query || query.trim() === "") {
    console.error(
      "✗ Usage: tool search <query> [--repo owner/name] [--kind issue|pull_request|discussion|comment|all] [--limit N] [--json]",
    );
    process.exit(1);
  }

  const validKinds = ["issue", "pull_request", "discussion", "comment", "all"];
  if (!validKinds.includes(kindArg)) {
    console.error(`✗ Unknown kind: ${kindArg}. Must be one of: ${validKinds.join(", ")}`);
    process.exit(1);
  }

  let limitNum = 10;
  if (limitStr !== undefined) {
    const parsed = Number(limitStr);
    if (!Number.isFinite(parsed)) {
      console.error(`✗ --limit must be a number, got: ${limitStr}`);
      process.exit(1);
    }
    limitNum = Math.floor(parsed);
  }

  await withDb(async (db) => {
    let repoMeta: Array<{ id: unknown; name_with_owner: string }>;

    if (repoArg) {
      const [rows] = await db.query<[Array<{ id: unknown; name_with_owner: string }>]>(
        "SELECT id, name_with_owner FROM repo WHERE name_with_owner = $nwo AND registered_at != NONE",
        { nwo: repoArg },
      );
      if (rows.length === 0) {
        console.error(`✗ Repo '${repoArg}' not registered — use \`tool add\` first`);
        process.exit(1);
      }
      repoMeta = rows;
    } else {
      const [rows] = await db.query<[Array<{ id: unknown; name_with_owner: string }>]>(
        "SELECT id, name_with_owner FROM repo WHERE registered_at != NONE",
      );
      repoMeta = rows;
    }

    if (repoMeta.length === 0) {
      if (jsonFlag) {
        console.log("[]");
      } else {
        console.log("(no registered repos — use `tool add <owner/name>` to register one)");
      }
      return;
    }

    const repoRefs = repoMeta.map((r) => new StringRecordId(String(r.id)));
    const repoNwoById = new Map(repoMeta.map((r) => [String(r.id), r.name_with_owner]));

    let vec: number[];
    try {
      vec = await embed(query);
    } catch (err) {
      console.error(`✗ Ollama not reachable: ${err}`);
      process.exit(1);
    }

    const activeKinds: SearchKind[] =
      kindArg === "all"
        ? ["issue", "pull_request", "discussion", "comment"]
        : [kindArg as SearchKind];

    const allResults: SearchResult[] = [];

    for (const kind of activeKinds) {
      if (kind === "comment") continue;

      const [rows] = await db.query<
        [
          Array<{
            id: unknown;
            number: number;
            title: string;
            github_url: string;
            repo: unknown;
            score: number;
          }>,
        ]
      >(
        `SELECT id, number, title, github_url, repo,
           vector::similarity::cosine(embedding, $vec) AS score
         FROM ${kind}
         WHERE embedding != NONE
           AND deleted_at IS NONE
           AND repo IN $repos
         ORDER BY score DESC LIMIT $limit`,
        { vec, repos: repoRefs, limit: limitNum },
      );

      for (const row of rows) {
        const nwo = repoNwoById.get(String(row.repo)) ?? String(row.repo);
        allResults.push({
          kind,
          repo: nwo,
          number: row.number,
          title: row.title,
          url: row.github_url,
          score: row.score,
        });
      }
    }

    if (activeKinds.includes("comment")) {
      const [issueIdRows] = await db.query<[Array<{ id: unknown }>]>(
        "SELECT id FROM issue WHERE repo IN $repos AND deleted_at IS NONE",
        { repos: repoRefs },
      );
      const [prIdRows] = await db.query<[Array<{ id: unknown }>]>(
        "SELECT id FROM pull_request WHERE repo IN $repos AND deleted_at IS NONE",
        { repos: repoRefs },
      );
      const [discIdRows] = await db.query<[Array<{ id: unknown }>]>(
        "SELECT id FROM discussion WHERE repo IN $repos AND deleted_at IS NONE",
        { repos: repoRefs },
      );

      const issueIds = issueIdRows.map((r) => new StringRecordId(String(r.id)));
      const prIds = prIdRows.map((r) => new StringRecordId(String(r.id)));
      const discIds = discIdRows.map((r) => new StringRecordId(String(r.id)));

      if (issueIds.length > 0 || prIds.length > 0 || discIds.length > 0) {
        const [commentRows] = await db.query<
          [
            Array<{
              id: unknown;
              github_url: string;
              parent_issue: unknown;
              parent_pr: unknown;
              parent_discussion: unknown;
              score: number;
            }>,
          ]
        >(
          `SELECT id, github_url, parent_issue, parent_pr, parent_discussion,
             vector::similarity::cosine(embedding, $vec) AS score
           FROM comment
           WHERE embedding != NONE
             AND deleted_at IS NONE
             AND (parent_issue IN $issueIds OR parent_pr IN $prIds OR parent_discussion IN $discIds)
           ORDER BY score DESC LIMIT $limit`,
          { vec, issueIds, prIds, discIds, limit: limitNum },
        );

        for (const comment of commentRows) {
          let parentKind: EntityKind;
          let parentRef: StringRecordId;

          if (comment.parent_issue) {
            parentKind = "issue";
            parentRef = new StringRecordId(String(comment.parent_issue));
          } else if (comment.parent_pr) {
            parentKind = "pull_request";
            parentRef = new StringRecordId(String(comment.parent_pr));
          } else {
            parentKind = "discussion";
            parentRef = new StringRecordId(String(comment.parent_discussion));
          }

          const [parentRows] = await db.query<
            [Array<{ number: number; title: string; github_url: string; repo: unknown }>]
          >(`SELECT number, title, github_url, repo FROM $id`, { id: parentRef });

          if (parentRows.length === 0) continue;
          const parent = parentRows[0];
          const nwo = repoNwoById.get(String(parent.repo)) ?? String(parent.repo);

          allResults.push({
            kind: "comment",
            subkind: parentKind,
            repo: nwo,
            number: parent.number,
            title: `(comment on) ${parent.title}`,
            url: comment.github_url,
            score: comment.score,
          });
        }
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    const results = allResults.slice(0, limitNum);

    if (jsonFlag) {
      console.log(
        JSON.stringify(
          results.map((r) => {
            const obj: Record<string, unknown> = {
              kind: r.kind,
              repo: r.repo,
              number: r.number,
              title: r.title,
              url: r.url,
              score: r.score,
            };
            if (r.kind === "comment") {
              obj.subkind = r.subkind;
            }
            return obj;
          }),
        ),
      );
      return;
    }

    if (results.length === 0) {
      console.log(
        "(no matches — try a different query, or run `tool sync`/`tool embed` first)",
      );
      return;
    }

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let kindLabel: string;
      if (r.kind === "pull_request") {
        kindLabel = "pr";
      } else if (r.kind === "comment") {
        const subLabel = r.subkind === "pull_request" ? "pr" : r.subkind;
        kindLabel = `comment on ${subLabel}`;
      } else {
        kindLabel = r.kind;
      }
      console.log(`${i + 1}. [${kindLabel}] ${r.title} (${r.repo}) — score: ${r.score.toFixed(4)}`);
      console.log(`   ${r.url}`);
      if (i < results.length - 1) console.log("");
    }
  });
}
