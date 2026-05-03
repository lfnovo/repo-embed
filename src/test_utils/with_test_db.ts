import { Surreal, createRemoteEngines } from "surrealdb";
import { createWasmEngines } from "@surrealdb/wasm";
import { readFileSync } from "fs";

const schema = readFileSync(import.meta.dir + "/../../schemas.surrealql", "utf-8");

export async function withTestDb<T>(fn: (db: Surreal) => Promise<T>): Promise<T> {
  const db = new Surreal({
    engines: { ...createRemoteEngines(), ...createWasmEngines() },
  });
  await db.connect("mem://", { namespace: "test", database: "test" });
  await db.query(schema);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}
