export type FieldValue = string | number | boolean | Date | object | null | undefined;

export interface FieldsResult {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Builds a SurrealQL SET clause from a plain JS object using tri-state semantics:
 * - concrete value → binds via $fieldName and appears in params
 * - null → inlines the SurrealQL literal NONE
 * - undefined → skips the field entirely
 */
export function updateSet(fields: Record<string, FieldValue>): FieldsResult {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`${key} = NONE`);
    } else {
      parts.push(`${key} = $${key}`);
      params[key] = value;
    }
  }

  return { sql: `SET ${parts.join(", ")}`, params };
}

/**
 * Builds a SurrealQL CONTENT object literal from a plain JS object using tri-state semantics:
 * - concrete value → binds via $fieldName and appears in params
 * - null → inlines the SurrealQL literal NONE
 * - undefined → skips the field entirely
 */
export function createContent(fields: Record<string, FieldValue>): FieldsResult {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`${key}: NONE`);
    } else {
      parts.push(`${key}: $${key}`);
      params[key] = value;
    }
  }

  return { sql: `{ ${parts.join(", ")} }`, params };
}
