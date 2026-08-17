import { describe, it, expect } from "vitest";
import { computeDiffRows } from "./diff-lines";

describe("computeDiffRows", () => {
  it("returns all same rows for identical strings", () => {
    const rows = computeDiffRows("line1\nline2\n", "line1\nline2\n");
    expect(rows).toEqual([
      { leftText: "line1", rightText: "line1", type: "same" },
      { leftText: "line2", rightText: "line2", type: "same" },
    ]);
  });

  it("pairs a single replaced line onto one changed row", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "old", rightText: "new", type: "changed" },
      { leftText: "b", rightText: "b", type: "same" },
    ]);
  });

  it("returns only same and added rows for an added-only change", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\nc\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "b", rightText: "b", type: "same" },
      { leftText: null, rightText: "c", type: "added" },
    ]);
  });

  it("returns only same and removed rows for a removed-only change", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "b", rightText: "b", type: "same" },
      { leftText: "c", rightText: null, type: "removed" },
    ]);
  });

  it("pairs matching lines and puts surplus added lines on their own rows", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew1\nnew2\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "old", rightText: "new1", type: "changed" },
      { leftText: null, rightText: "new2", type: "added" },
      { leftText: "b", rightText: "b", type: "same" },
    ]);
  });
});
