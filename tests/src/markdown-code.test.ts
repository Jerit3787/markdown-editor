import { describe, it, expect } from "vitest";
import { replaceOutsideCode, codeSegmentRanges } from "../../src/markdown-code";

describe("markdown-code (Worker copy)", () => {
  it("replaceOutsideCode skips a code span", () => {
    expect(replaceOutsideCode("a `x` x", /x/g, (m) => m.toUpperCase())).toBe("a `x` X");
  });
  it("codeSegmentRanges finds a fenced block", () => {
    const src = "p\n```\nq\n```\n";
    const [r] = codeSegmentRanges(src);
    expect(src.slice(r!.from, r!.to)).toBe("```\nq\n```");
  });
});
