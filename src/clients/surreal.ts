import { Surreal } from "surrealdb";
import { config } from "../config.ts";

export async function withDb<T>(fn: (db: Surreal) => Promise<T>): Promise<T> {
  const db = new Surreal();
  await db.connect(config.SURREAL_URL, {
    namespace: config.SURREAL_NS,
    database: config.SURREAL_DB,
    authentication: {
      username: config.SURREAL_USER,
      password: config.SURREAL_PASS,
    },
  });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}
