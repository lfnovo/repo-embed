import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import type { ParsedLabel } from "./types.ts";

// STUB: refined by #6. Stable signature.
export async function upsertLabelsAndEdges(
  db: Surreal,
  parentRecordId: string,
  labels: ParsedLabel[],
): Promise<void> {
  const parentRef = new StringRecordId(parentRecordId);

  const [parentRows] = await db.query<[Array<{ repo: unknown }>]>(
    "SELECT repo FROM $parentRef",
    { parentRef },
  );

  const repoId = parentRows[0]?.repo;

  for (const label of labels) {
    const [existing] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM label WHERE github_node_id = $github_node_id",
      { github_node_id: label.github_node_id },
    );

    // SurrealDB option<string> accepts strings or NONE, not JS null.
    // Inline NONE as a SQL literal when description is null.
    const descSql = label.description === null ? "NONE" : "$description";
    const descParam = label.description !== null ? { description: label.description } : {};

    let labelId: unknown;
    if (existing.length === 0) {
      const [created] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE label CONTENT {
          github_node_id: $github_node_id,
          repo: $repo,
          name: $name,
          color: $color,
          description: ${descSql},
          created_at: time::now(),
          updated_at: time::now(),
          deleted_at: NONE
        }`,
        {
          github_node_id: label.github_node_id,
          repo: repoId,
          name: label.name,
          color: label.color,
          ...descParam,
        },
      );
      labelId = created[0].id;
    } else {
      labelId = existing[0].id;
      await db.query(
        `UPDATE $id SET
          name = $name,
          color = $color,
          description = ${descSql},
          updated_at = time::now()`,
        {
          id: labelId,
          name: label.name,
          color: label.color,
          ...descParam,
        },
      );
    }

    const [edges] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM has_label WHERE in = $parentRef AND out = $labelId",
      { parentRef, labelId },
    );

    if (edges.length === 0) {
      await db.query(
        "RELATE $parentRef->has_label->$labelId CONTENT { created_at: time::now() }",
        { parentRef, labelId },
      );
    }
  }
}
