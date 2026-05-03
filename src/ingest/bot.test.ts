import { describe, it, expect } from "bun:test";
import { isBot } from "./bot.ts";

describe("isBot", () => {
  it("returns true for Bot typename", () => {
    expect(isBot("Bot", "x")).toBe(true);
  });

  it("returns true for [bot] login suffix", () => {
    expect(isBot("User", "dependabot[bot]")).toBe(true);
  });

  it("returns true for github-actions[bot] login", () => {
    expect(isBot("User", "github-actions[bot]")).toBe(true);
  });

  it("returns true for renovate[bot] login", () => {
    expect(isBot("User", "renovate[bot]")).toBe(true);
  });

  it("returns false for regular user", () => {
    expect(isBot("User", "lfnovo")).toBe(false);
  });

  it("returns false for Mergify-Bot (no allowlist, suffix check fails)", () => {
    expect(isBot("User", "Mergify-Bot")).toBe(false);
  });

  it("returns false for empty login", () => {
    expect(isBot("User", "")).toBe(false);
  });
});
