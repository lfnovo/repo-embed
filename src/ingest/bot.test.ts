import { describe, it, expect } from "bun:test";
import { isBot } from "./bot.ts";

describe("isBot", () => {
  it("returns true for Bot typename", () => {
    expect(isBot("Bot", "x")).toBe(true);
  });

  it("returns true for [bot] login suffix", () => {
    expect(isBot("User", "dependabot[bot]")).toBe(true);
  });

  it("returns false for regular user", () => {
    expect(isBot("User", "lfnovo")).toBe(false);
  });
});
