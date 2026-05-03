import { withDb } from "../clients/surreal.ts";

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

export default async function run(args: string[]): Promise<void> {
  const json = args.includes("--json");

  await withDb(async (db) => {
    const [rows] = await db.query<
      [Array<{ name_with_owner: string; last_synced_at: unknown }>]
    >(
      "SELECT name_with_owner, last_synced_at FROM repo WHERE registered_at != NONE ORDER BY name_with_owner",
    );

    if (json) {
      console.log(JSON.stringify(rows));
      return;
    }

    if (rows.length === 0) {
      console.log("(no repos registered — use `tool add owner/name`)");
      return;
    }

    const nameWidth = 35;
    console.log(`${"NAME".padEnd(nameWidth)}  LAST SYNCED`);
    for (const row of rows) {
      const name = row.name_with_owner.padEnd(nameWidth);
      const synced = formatDate(row.last_synced_at);
      console.log(`${name}  ${synced}`);
    }
  });
}
