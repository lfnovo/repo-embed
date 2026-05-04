import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import type { RepoRef } from "./types.ts";

export type CrossRef = {
  owner: string | null;
  repo: string | null;
  number: number;
  isClosing: boolean;
};

export function extractReferences(
  body: string,
  context?: { owner: string; name: string; number: number }
): CrossRef[] {
  // Strip fenced code blocks
  let text = body.replace(/```[\s\S]*?```/g, "");
  // Strip URLs
  text = text.replace(/https?:\/\/\S+/g, "");

  const results: CrossRef[] = [];
  const seen = new Set<string>();
  const closingKeyword = /(?:Fixes|Closes|Resolves)\s+$/i;

  // Cross-repo: owner/repo#N
  const crossRepoRe = /\b([\w-]+)\/([\w.-]+)#(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = crossRepoRe.exec(text)) !== null) {
    const owner = m[1];
    const repo = m[2];
    const num = parseInt(m[3], 10);
    const isClosing = closingKeyword.test(text.slice(0, m.index));
    const key = `${owner}/${repo}#${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ owner, repo, number: num, isClosing });
    }
  }

  // Same-repo: #N (not part of a cross-repo pattern or URL path)
  const sameRepoRe = /(?<![/\w])#(\d+)\b/g;
  while ((m = sameRepoRe.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    if (context && context.number === num) continue;
    const isClosing = closingKeyword.test(text.slice(0, m.index));
    const key = `null/null#${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ owner: null, repo: null, number: num, isClosing });
    }
  }

  return results;
}

// STUB: refined by #8. Stable signature.
export async function linkClosingIssues(
  db: Surreal,
  prRecordId: string,
  closingIssueNodeIds: string[],
): Promise<void> {
  const prRef = new StringRecordId(prRecordId);

  for (const nodeId of closingIssueNodeIds) {
    const [issueRows] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM issue WHERE github_node_id = $nodeId",
      { nodeId },
    );

    if (issueRows.length === 0) continue;

    const issueRef = new StringRecordId(String(issueRows[0].id));

    const [edges] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM closes WHERE in = $prRef AND out = $issueRef",
      { prRef, issueRef },
    );

    if (edges.length === 0) {
      await db.query(
        "RELATE $prRef->closes->$issueRef CONTENT { created_at: time::now() }",
        { prRef, issueRef },
      );
    }
  }
  // Cross-repo closing refs from closingIssuesReferences are a future enhancement (#8 design note)
}

type EntityRow = { id: unknown; number: number; body: string | null };

async function lookupByNumber(
  db: Surreal,
  repoRef: StringRecordId,
  num: number,
): Promise<StringRecordId | null> {
  for (const table of ["issue", "pull_request", "discussion"] as const) {
    const [rows] = await db.query<[Array<{ id: unknown }>]>(
      `SELECT id FROM ${table} WHERE repo = $repoRef AND number = $num`,
      { repoRef, num },
    );
    if (rows.length > 0) return new StringRecordId(String(rows[0].id));
  }
  return null;
}

export async function extractAndLinkCrossRefs(
  db: Surreal,
  repo: RepoRef,
): Promise<{ same_repo_refs: number; cross_repo_refs_resolved: number; cross_repo_refs_dangling: number }> {
  const [owner, name] = repo.name_with_owner.split("/");
  const repoRef = new StringRecordId(repo.id);

  let same_repo_refs = 0;
  let cross_repo_refs_resolved = 0;
  let cross_repo_refs_dangling = 0;

  const [issues] = await db.query<[EntityRow[]]>(
    "SELECT id, number, body FROM issue WHERE repo = $repoRef",
    { repoRef },
  );
  const [prs] = await db.query<[EntityRow[]]>(
    "SELECT id, number, body FROM pull_request WHERE repo = $repoRef",
    { repoRef },
  );
  // discussions and comments are skipped: references_ref FROM/TO cannot be widened while
  // @surrealdb/wasm lacks DEFINE TABLE ... OVERWRITE support (see schemas.surrealql note)

  type Entity = { id: unknown; body: string | null; number?: number };
  const entities: Entity[] = [
    ...issues.map((r) => ({ id: r.id, body: r.body, number: r.number })),
    ...prs.map((r) => ({ id: r.id, body: r.body, number: r.number })),
  ];

  for (const entity of entities) {
    const parentRef = new StringRecordId(String(entity.id));

    // Replace-all: clear prior refs for this parent before re-creating
    await db.query("DELETE references_ref WHERE in = $parentRef", { parentRef });

    const context =
      entity.number != null ? { owner, name, number: entity.number } : undefined;
    const refs = extractReferences(entity.body ?? "", context);

    for (const ref of refs) {
      if (ref.owner === null) {
        // Same-repo reference
        const targetRef = await lookupByNumber(db, repoRef, ref.number);
        if (targetRef !== null) {
          await db.query(
            "RELATE $parentRef->references_ref->$targetRef CONTENT { created_at: time::now() }",
            { parentRef, targetRef },
          );
          same_repo_refs++;
        }
        // Not found: no edge, no dangling row (same-repo missing targets are ignored)
      } else {
        // Cross-repo reference
        const targetNwo = `${ref.owner}/${ref.repo}`;
        const [targetRepoRows] = await db.query<[Array<{ id: unknown }>]>(
          "SELECT id FROM repo WHERE name_with_owner = $nwo",
          { nwo: targetNwo },
        );

        if (targetRepoRows.length === 0) {
          // Repo not mirrored: write dangling_reference row
          await db.query(
            `CREATE dangling_reference CONTENT {
              parent: $parentRef,
              target_owner: $targetOwner,
              target_repo: $targetRepo,
              target_number: $targetNumber,
              ref_kind: 'references_ref',
              detected_at: time::now()
            }`,
            {
              parentRef,
              targetOwner: ref.owner,
              targetRepo: ref.repo,
              targetNumber: ref.number,
            },
          );
          cross_repo_refs_dangling++;
        } else {
          const targetRepoRef = new StringRecordId(String(targetRepoRows[0].id));
          const targetRef = await lookupByNumber(db, targetRepoRef, ref.number);
          if (targetRef !== null) {
            await db.query(
              "RELATE $parentRef->references_ref->$targetRef CONTENT { created_at: time::now() }",
              { parentRef, targetRef },
            );
            cross_repo_refs_resolved++;
          } else {
            await db.query(
              `CREATE dangling_reference CONTENT {
                parent: $parentRef,
                target_owner: $targetOwner,
                target_repo: $targetRepo,
                target_number: $targetNumber,
                ref_kind: 'references_ref',
                detected_at: time::now()
              }`,
              {
                parentRef,
                targetOwner: ref.owner,
                targetRepo: ref.repo,
                targetNumber: ref.number,
              },
            );
            cross_repo_refs_dangling++;
          }
        }
      }
    }
  }

  return { same_repo_refs, cross_repo_refs_resolved, cross_repo_refs_dangling };
}

export async function materializeDanglingReferences(
  db: Surreal,
  repo: RepoRef,
): Promise<{ materialized: number }> {
  const [owner, name] = repo.name_with_owner.split("/");
  const targetRepoRef = new StringRecordId(repo.id);

  type DanglingRow = {
    id: unknown;
    parent: unknown;
    target_number: number;
    ref_kind: string;
  };

  const [danglingRows] = await db.query<[DanglingRow[]]>(
    "SELECT * FROM dangling_reference WHERE target_owner = $owner AND target_repo = $name",
    { owner, name },
  );

  let materialized = 0;

  for (const row of danglingRows) {
    const danglingId = new StringRecordId(String(row.id));
    const parentRef = new StringRecordId(String(row.parent));

    const targetRef = await lookupByNumber(db, targetRepoRef, row.target_number);
    if (targetRef !== null) {
      await db.query(
        "RELATE $parentRef->references_ref->$targetRef CONTENT { created_at: time::now() }",
        { parentRef, targetRef },
      );
      await db.query("DELETE $danglingId", { danglingId });
      materialized++;
    }
  }

  return { materialized };
}
