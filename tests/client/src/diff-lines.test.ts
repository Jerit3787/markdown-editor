import { describe, it, expect } from "vitest";
import { computeDiffRows, toUnifiedLines } from "../../../client/src/diff-lines";

describe("computeDiffRows", () => {
  it("returns all same rows for identical strings", () => {
    const rows = computeDiffRows("line1\nline2\n", "line1\nline2\n");
    expect(rows).toEqual([
      { leftText: "line1", rightText: "line1", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "line2", rightText: "line2", leftLine: 2, rightLine: 2, leftSegments: null, rightSegments: null, type: "same" },
    ]);
  });

  it("pairs a single replaced line onto one changed row", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      {
        leftText: "old",
        rightText: "new",
        leftLine: 2,
        rightLine: 2,
        leftSegments: [{ text: "old", changed: true }],
        rightSegments: [{ text: "new", changed: true }],
        type: "changed",
      },
      { leftText: "b", rightText: "b", leftLine: 3, rightLine: 3, leftSegments: null, rightSegments: null, type: "same" },
    ]);
  });

  it("returns only same and added rows for an added-only change", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\nc\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "b", rightText: "b", leftLine: 2, rightLine: 2, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: null, rightText: "c", leftLine: null, rightLine: 3, leftSegments: null, rightSegments: null, type: "added" },
    ]);
  });

  it("returns only same and removed rows for a removed-only change", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "b", rightText: "b", leftLine: 2, rightLine: 2, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "c", rightText: null, leftLine: 3, rightLine: null, leftSegments: null, rightSegments: null, type: "removed" },
    ]);
  });

  it("pairs matching lines and puts surplus added lines on their own rows", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew1\nnew2\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      {
        leftText: "old",
        rightText: "new1",
        leftLine: 2,
        rightLine: 2,
        leftSegments: [{ text: "old", changed: true }],
        rightSegments: [{ text: "new1", changed: true }],
        type: "changed",
      },
      { leftText: null, rightText: "new2", leftLine: null, rightLine: 3, leftSegments: null, rightSegments: null, type: "added" },
      { leftText: "b", rightText: "b", leftLine: 3, rightLine: 4, leftSegments: null, rightSegments: null, type: "same" },
    ]);
  });
});

describe("computeDiffRows — intraline segments", () => {
  it("is null on same/removed/added rows", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\nc\n");
    for (const row of rows) {
      expect(row.leftSegments).toBeNull();
      expect(row.rightSegments).toBeNull();
    }
  });

  it("marks the single changed word within an otherwise-identical line", () => {
    const rows = computeDiffRows("a\nthe old cat\nb\n", "a\nthe new cat\nb\n");
    const changed = rows.find((r) => r.type === "changed")!;
    expect(changed.leftSegments).toEqual([
      { text: "the ", changed: false },
      { text: "old", changed: true },
      { text: " cat", changed: false },
    ]);
    expect(changed.rightSegments).toEqual([
      { text: "the ", changed: false },
      { text: "new", changed: true },
      { text: " cat", changed: false },
    ]);
  });

  it("marks every word as changed when a line shares no words with its replacement", () => {
    const rows = computeDiffRows("hello world\n", "goodbye moon\n");
    const changed = rows.find((r) => r.type === "changed")!;
    expect(changed.leftSegments).toEqual([
      { text: "hello", changed: true },
      { text: " ", changed: false },
      { text: "world", changed: true },
    ]);
    expect(changed.rightSegments).toEqual([
      { text: "goodbye", changed: true },
      { text: " ", changed: false },
      { text: "moon", changed: true },
    ]);
  });

  it("handles a multi-word change with an added trailing word", () => {
    const rows = computeDiffRows("quick brown fox\n", "quick red fox jumps\n");
    const changed = rows.find((r) => r.type === "changed")!;
    expect(changed.leftSegments).toEqual([
      { text: "quick ", changed: false },
      { text: "brown", changed: true },
      { text: " fox", changed: false },
    ]);
    expect(changed.rightSegments).toEqual([
      { text: "quick ", changed: false },
      { text: "red", changed: true },
      { text: " fox", changed: false },
      { text: " jumps", changed: true },
    ]);
  });
});

describe("toUnifiedLines", () => {
  it("maps same/removed/added rows 1:1", () => {
    const lines = toUnifiedLines([
      { leftText: "a", rightText: "a", leftLine: 1, rightLine: 1, leftSegments: null, rightSegments: null, type: "same" },
      { leftText: "old", rightText: null, leftLine: 2, rightLine: null, leftSegments: null, rightSegments: null, type: "removed" },
      { leftText: null, rightText: "new", leftLine: null, rightLine: 2, leftSegments: null, rightSegments: null, type: "added" },
    ]);
    expect(lines).toEqual([
      { text: "a", segments: null, type: "same", leftLine: 1, rightLine: 1 },
      { text: "old", segments: null, type: "removed", leftLine: 2, rightLine: null },
      { text: "new", segments: null, type: "added", leftLine: null, rightLine: 2 },
    ]);
  });

  it("expands a changed row into a removed line then an added line, carrying segments", () => {
    const leftSegments = [
      { text: "the ", changed: false },
      { text: "old", changed: true },
      { text: " cat", changed: false },
    ];
    const rightSegments = [
      { text: "the ", changed: false },
      { text: "new", changed: true },
      { text: " cat", changed: false },
    ];
    const lines = toUnifiedLines([
      { leftText: "the old cat", rightText: "the new cat", leftLine: 5, rightLine: 5, leftSegments, rightSegments, type: "changed" },
    ]);
    expect(lines).toEqual([
      { text: "the old cat", segments: leftSegments, type: "removed", leftLine: 5, rightLine: null },
      { text: "the new cat", segments: rightSegments, type: "added", leftLine: null, rightLine: 5 },
    ]);
  });
});
