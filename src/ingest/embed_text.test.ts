import { describe, it, expect } from "bun:test";
import { embedText, EMBED_TEXT_MAX_CHARS } from "./embed_text";

describe("embedText", () => {
  it("joins title and body with double newline", () => {
    expect(embedText({ title: "Foo", body: "Bar" })).toBe("Foo\n\nBar");
  });

  it("returns body only when title is absent", () => {
    expect(embedText({ body: "comment text" })).toBe("comment text");
  });

  it("returns empty string when both are null", () => {
    expect(embedText({ title: null, body: null })).toBe("");
  });

  it("normalises CRLF in body", () => {
    expect(embedText({ title: "T", body: "Body with\r\nCRLF" })).toBe("T\n\nBody with\nCRLF");
  });

  it("truncates inputs longer than EMBED_TEXT_MAX_CHARS", () => {
    const longBody = "x".repeat(EMBED_TEXT_MAX_CHARS + 100);
    const out = embedText({ title: null, body: longBody });
    expect(out.length).toBe(EMBED_TEXT_MAX_CHARS);
  });

  it("does not truncate inputs at or below the cap", () => {
    const exact = "x".repeat(EMBED_TEXT_MAX_CHARS);
    expect(embedText({ title: null, body: exact }).length).toBe(EMBED_TEXT_MAX_CHARS);
  });
});
