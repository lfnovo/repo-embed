import { config } from "../config.ts";
import { withDb } from "../clients/surreal.ts";

try {
  await withDb(async (db) => {
    const info = await db.query("INFO FOR DB");
    const dbInfo = (info?.[0] ?? {}) as Record<string, unknown>;
    const keys = Object.keys(dbInfo);

    console.log("✓ SurrealDB reachable.");
    console.log(`  url=${config.SURREAL_URL}`);
    console.log(`  namespace=${config.SURREAL_NS} database=${config.SURREAL_DB}`);
    console.log(`  INFO FOR DB sections: ${keys.join(", ") || "(empty db)"}`);
  });
  process.exit(0);
} catch (err) {
  console.error("✗ SurrealDB smoke test failed.");
  console.error(err);
  process.exit(1);
}
