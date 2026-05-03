import type { Surreal } from "surrealdb";
import type { ParsedUser } from "./types.ts";

export async function upsertUser(db: Surreal, parsed: ParsedUser): Promise<string> {
  const [existing] = await db.query<[Array<{ id: unknown }>]>(
    "SELECT id FROM user WHERE github_node_id = $github_node_id",
    { github_node_id: parsed.github_node_id },
  );

  if (existing.length > 0) {
    await db.query(
      `UPDATE $id SET
        login = $login,
        is_bot = $is_bot,
        github_url = $github_url,
        updated_at = time::now()`,
      {
        id: existing[0].id,
        login: parsed.login,
        is_bot: parsed.is_bot,
        github_url: parsed.github_url,
      },
    );
    return String(existing[0].id);
  }

  const [created] = await db.query<[Array<{ id: unknown }>]>(
    `CREATE user CONTENT {
      github_node_id: $github_node_id,
      github_url: $github_url,
      login: $login,
      name: NONE,
      is_bot: $is_bot,
      created_at: time::now(),
      updated_at: time::now(),
      deleted_at: NONE
    }`,
    {
      github_node_id: parsed.github_node_id,
      github_url: parsed.github_url,
      login: parsed.login,
      is_bot: parsed.is_bot,
    },
  );

  return String(created[0].id);
}
