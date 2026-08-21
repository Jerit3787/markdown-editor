import { describe, expect, it } from "vitest";
import { fuzzyScore } from "../../../client/src/fuzzy-match";

describe("fuzzyScore", () => {
  it("matches an exact string with the lowest possible score", () => {
    expect(fuzzyScore("bold", "bold")).toBe(0);
  });

  it("matches a subsequence that isn't contiguous", () => {
    expect(fuzzyScore("bd", "bold")).not.toBeNull();
  });

  it("returns null when the query isn't a subsequence of the target", () => {
    expect(fuzzyScore("xyz", "bold")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("BOLD", "bold")).toBe(0);
    expect(fuzzyScore("bold", "Bold Text")).not.toBeNull();
  });

  it("returns 0 for an empty query against anything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("scores a tighter, earlier match lower (better) than a looser one", () => {
    const tight = fuzzyScore("bold", "Bold Text");
    const loose = fuzzyScore("bold", "Big Old Later Description");
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight as number).toBeLessThan(loose as number);
  });

  it("matches every character of the query, not just a prefix", () => {
    expect(fuzzyScore("hdr", "Header 3")).not.toBeNull();
    expect(fuzzyScore("h3x", "Header 3")).toBeNull();
  });
});
