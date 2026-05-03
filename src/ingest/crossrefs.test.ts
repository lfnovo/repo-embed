import { describe, it, expect } from "bun:test";
import { extractReferences } from "./crossrefs.ts";

describe("extractReferences", () => {
  it("extracts a same-repo #N mention", () => {
    expect(extractReferences("See #5")).toEqual([
      { owner: null, repo: null, number: 5, isClosing: false },
    ]);
  });

  it("extracts a cross-repo owner/repo#N mention", () => {
    expect(extractReferences("See other/project#12")).toEqual([
      { owner: "other", repo: "project", number: 12, isClosing: false },
    ]);
  });

  it("sets isClosing for Fixes keyword", () => {
    expect(extractReferences("Fixes #3")).toEqual([
      { owner: null, repo: null, number: 3, isClosing: true },
    ]);
  });

  it("sets isClosing for Closes keyword", () => {
    expect(extractReferences("Closes #3")).toEqual([
      { owner: null, repo: null, number: 3, isClosing: true },
    ]);
  });

  it("sets isClosing for Resolves keyword", () => {
    expect(extractReferences("Resolves #3")).toEqual([
      { owner: null, repo: null, number: 3, isClosing: true },
    ]);
  });

  it("skips references inside fenced code blocks", () => {
    expect(extractReferences("```\n#4\n```")).toEqual([]);
  });

  it("skips references inside URLs", () => {
    expect(extractReferences("https://github.com/foo/bar#1")).toEqual([]);
  });

  it("skips self-references", () => {
    expect(
      extractReferences("#42", { owner: "a", name: "b", number: 42 })
    ).toEqual([]);
  });

  it("deduplicates repeated same-repo references", () => {
    expect(extractReferences("#5 and #5 again")).toEqual([
      { owner: null, repo: null, number: 5, isClosing: false },
    ]);
  });
});
