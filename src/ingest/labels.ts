import { z } from "zod";
import { StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import { paginate } from "../clients/github.ts";
import { createContent, updateSet } from "../clients/surreal_helpers.ts";
import type { ParsedLabel, RepoRef } from "./types.ts";

const LabelNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

const LABELS_CATALOG_QUERY = `
  query FetchLabelsCatalog($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      labels(first: 100, after: $cursor, orderBy: {field: NAME, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes { id name color description }
      }
    }
  }
`;

export async function* fetchLabelsCatalog(
  owner: string,
  name: string,
): AsyncGenerator<ParsedLabel> {
  for await (const rawNode of paginate(
    LABELS_CATALOG_QUERY,
    { owner, name },
    (data: unknown) => {
      const d = data as {
        repository: {
          labels: {
            nodes: unknown[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      return d.repository.labels;
    },
  )) {
    const node = LabelNodeSchema.parse(rawNode);
    yield {
      github_node_id: node.id,
      name: node.name,
      color: node.color,
      description: node.description,
    };
  }
}

export async function persistLabelCatalog(
  db: Surreal,
  repo: RepoRef,
  parsed: ParsedLabel,
): Promise<void> {
  const repoRef = new StringRecordId(repo.id);

  const [existing] = await db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM label WHERE github_node_id = $github_node_id",
    { github_node_id: parsed.github_node_id },
  );

  if (existing.length === 0) {
    const content = createContent({
      github_node_id: parsed.github_node_id,
      repo: repoRef,
      name: parsed.name,
      color: parsed.color,
      description: parsed.description,
      deleted_at: null,
    });
    await db.query(
      `CREATE label CONTENT ${content.sql.slice(0, -2)}, created_at: time::now(), updated_at: time::now() }`,
      content.params,
    );
  } else {
    const set = updateSet({
      name: parsed.name,
      color: parsed.color,
      description: parsed.description,
      repo: repoRef,
    });
    await db.query(
      `UPDATE $id ${set.sql}, updated_at = time::now()`,
      { id: existing[0].id, ...set.params },
    );
  }
}

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

  const labelIds: unknown[] = [];
  for (const label of labels) {
    const [existing] = await db.query<[Array<{ id: unknown }>]>(
      "SELECT id FROM label WHERE github_node_id = $github_node_id",
      { github_node_id: label.github_node_id },
    );

    let labelId: unknown;
    if (existing.length === 0) {
      const content = createContent({
        github_node_id: label.github_node_id,
        repo: repoId as object,
        name: label.name,
        color: label.color,
        description: label.description,
        deleted_at: null,
      });
      const [created] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE label CONTENT ${content.sql.slice(0, -2)}, created_at: time::now(), updated_at: time::now() }`,
        content.params,
      );
      labelId = created[0].id;
    } else {
      labelId = existing[0].id;
      const set = updateSet({
        name: label.name,
        color: label.color,
        description: label.description,
      });
      await db.query(
        `UPDATE $id ${set.sql}, updated_at = time::now()`,
        { id: labelId, ...set.params },
      );
    }
    labelIds.push(labelId);
  }

  await db.query("DELETE has_label WHERE in = $parentRef", { parentRef });

  for (const labelId of labelIds) {
    await db.query(
      "RELATE $parentRef->has_label->$labelId CONTENT { created_at: time::now() }",
      { parentRef, labelId },
    );
  }
}
