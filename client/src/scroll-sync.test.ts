import { describe, it, expect } from "vitest";
import { computeBlockLineStarts } from "./scroll-sync";

describe("computeBlockLineStarts", () => {
  it("returns an empty array for empty input", () => {
    expect(computeBlockLineStarts("")).toEqual([]);
  });

  it("returns line 0 for a single block", () => {
    expect(computeBlockLineStarts("Just one paragraph.")).toEqual([0]);
  });

  it("computes start lines for multiple blank-line-separated blocks", () => {
    const raw = "# Heading\n\nFirst paragraph.\n\nSecond paragraph.";
    // line 0: "# Heading", line 1: blank, line 2: "First paragraph.",
    // line 3: blank, line 4: "Second paragraph."
    expect(computeBlockLineStarts(raw)).toEqual([0, 2, 4]);
  });

  it("treats a heading immediately followed by a paragraph (no blank line) as two separate blocks", () => {
    const raw = "# Heading\nParagraph right after, no blank line.";
    expect(computeBlockLineStarts(raw)).toEqual([0, 1]);
  });

  it("treats a blank-line-delimited $$...$$ span as a single block on the original raw text", () => {
    const raw = "Before.\n\n$$\nx^2\n$$\n\nAfter.";
    // marked has no special knowledge of $$ math — on the original,
    // unextracted text this is just a paragraph spanning lines 2-4.
    // line 0: "Before.", line 1: blank, line 2: "$$", line 6: "After."
    expect(computeBlockLineStarts(raw)).toEqual([0, 2, 6]);
  });

  it("computes correct line numbers after a multi-line fenced code block", () => {
    const raw = "Before.\n\n```\nline a\nline b\nline c\n```\n\nAfter.";
    expect(computeBlockLineStarts(raw)).toEqual([0, 2, 8]);
  });

  it("handles multiple consecutive blank lines between blocks", () => {
    const raw = "First.\n\n\n\nSecond.";
    expect(computeBlockLineStarts(raw)).toEqual([0, 4]);
  });
});
