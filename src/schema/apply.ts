import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Surreal } from "surrealdb";
import { config } from "../config.ts";

const SCHEMA_PATH = resolve(import.meta.dir, "../../schemas.surrealql");

const db = new Surreal();

try {
  const surql = await readFile(SCHEMA_PATH, "utf-8");

  await db.connect(config.SURREAL_URL, {
    namespace: config.SURREAL_NS,
    database: config.SURREAL_DB,
    authentication: {
      username: config.SURREAL_USER,
      password: config.SURREAL_PASS,
    },
  });

  const results = await db.query(surql);

  let errors = 0;
  for (const result of results) {
    if (result instanceof Error) {
      errors++;
      console.error(`  - ${result.message}`);
    }
  }

  if (errors > 0) {
    console.error(`✗ Schema apply finished with ${errors} error(s).`);
    await db.close();
    process.exit(1);
  }

  console.log("✓ Schema applied.");
  console.log(`  file=${SCHEMA_PATH}`);
  console.log(`  statements=${results.length}`);

  await db.close();
  process.exit(0);
} catch (err) {
  console.error("✗ Schema apply failed.");
  console.error(err);
  process.exit(1);
}
