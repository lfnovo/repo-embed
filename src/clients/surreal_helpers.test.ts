import { describe, expect, test } from "bun:test";
import { createContent, updateSet } from "./surreal_helpers.ts";

describe("updateSet", () => {
  test("concrete value binds via $fieldName", () => {
    const result = updateSet({ title: "hello" });
    expect(result).toEqual({ sql: "SET title = $title", params: { title: "hello" } });
  });

  test("null inlines NONE", () => {
    const result = updateSet({ body: null });
    expect(result).toEqual({ sql: "SET body = NONE", params: {} });
  });

  test("undefined skips the field entirely", () => {
    const result = updateSet({ author: undefined });
    expect(result).toEqual({ sql: "SET ", params: {} });
  });

  test("mixed: concrete value, null, undefined", () => {
    const result = updateSet({ title: "hello", body: null, author: undefined });
    expect(result).toEqual({
      sql: "SET title = $title, body = NONE",
      params: { title: "hello" },
    });
  });

  test("number value binds via $fieldName", () => {
    const result = updateSet({ number: 42 });
    expect(result).toEqual({ sql: "SET number = $number", params: { number: 42 } });
  });

  test("Date value binds via $fieldName", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const result = updateSet({ created_at: date });
    expect(result).toEqual({ sql: "SET created_at = $created_at", params: { created_at: date } });
  });

  test("all fields undefined returns empty SET clause", () => {
    const result = updateSet({ a: undefined, b: undefined });
    expect(result.sql).toBe("SET ");
    expect(result.params).toEqual({});
  });

  test("empty input {} produces empty SET clause", () => {
    const result = updateSet({});
    expect(result).toEqual({ sql: "SET ", params: {} });
  });
});

describe("createContent", () => {
  test("concrete value binds via $fieldName", () => {
    const result = createContent({ github_node_id: "abc" });
    expect(result).toEqual({
      sql: "{ github_node_id: $github_node_id }",
      params: { github_node_id: "abc" },
    });
  });

  test("null inlines NONE", () => {
    const result = createContent({ body: null });
    expect(result).toEqual({ sql: "{ body: NONE }", params: {} });
  });

  test("undefined skips the field entirely", () => {
    const result = createContent({ author: undefined });
    expect(result).toEqual({ sql: "{  }", params: {} });
  });

  test("mixed: concrete value, null, undefined", () => {
    const result = createContent({ github_node_id: "abc", body: null, author: undefined });
    expect(result).toEqual({
      sql: "{ github_node_id: $github_node_id, body: NONE }",
      params: { github_node_id: "abc" },
    });
  });

  test("number value binds via $fieldName", () => {
    const result = createContent({ count: 5 });
    expect(result).toEqual({ sql: "{ count: $count }", params: { count: 5 } });
  });

  test("boolean value binds via $fieldName", () => {
    const result = createContent({ active: true });
    expect(result).toEqual({ sql: "{ active: $active }", params: { active: true } });
  });

  test("empty input {} produces empty content literal", () => {
    const result = createContent({});
    expect(result.sql).toMatch(/^\{[\s]*\}$/);
    expect(result.params).toEqual({});
  });
});
