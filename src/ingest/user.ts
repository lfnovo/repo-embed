import type { Surreal } from "surrealdb";
import { createContent, updateSet } from "../clients/surreal_helpers.ts";
import type { ParsedUser } from "./types.ts";

export async function upsertUser(db: Surreal, parsed: ParsedUser): Promise<string> {
  const [existing] = await db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM user WHERE github_node_id = $github_node_id",
    { github_node_id: parsed.github_node_id },
  );

  if (existing.length > 0) {
    const set = updateSet({
      login: parsed.login,
      is_bot: parsed.is_bot,
      github_url: parsed.github_url,
    });
    await db.query(
      `UPDATE $id ${set.sql}, updated_at = time::now()`,
      { id: existing[0].id, ...set.params },
    );
    return String(existing[0].id);
  }

  const content = createContent({
    github_node_id: parsed.github_node_id,
    github_url: parsed.github_url,
    login: parsed.login,
    name: null,
    is_bot: parsed.is_bot,
    deleted_at: null,
  });
  const [created] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE user CONTENT ${content.sql.slice(0, -2)}, created_at: time::now(), updated_at: time::now() }`,
    content.params,
  );

  return String(created[0].id);
}
