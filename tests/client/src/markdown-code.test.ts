import { describe, it, expect } from "vitest";
import { replaceOutsideCode, codeSegmentRanges, isInsideCode, CODE_SEGMENT_RE } from "../../../client/src/markdown-code";

const upper = (m: string) => m.toUpperCase();

describe("replaceOutsideCode", () => {
  it("applies the replacer outside code, verbatim inside", () => {
    expect(replaceOutsideCode("a `x b x` c x", /x/g, upper)).toBe("a `x b x` c X");
  });
  it("skips a fenced block spanning lines", () => {
    const src = "x\n```\nx x\n```\nx";
    expect(replaceOutsideCode(src, /x/g, upper)).toBe("X\n```\nx x\n```\nX");
  });
  it("handles adjacent code spans", () => {
    expect(replaceOutsideCode("`x``x` x", /x/g, upper)).toBe("`x``x` X");
  });
  it("passes capture groups through to the replacer", () => {
    expect(replaceOutsideCode("[[A]] `[[B]]`", /\[\[([^\]]+)\]\]/g, (_m, n) => `<${n}>`)).toBe("<A> `[[B]]`");
  });
  it("leaves text with no code untouched by an unmatched pattern", () => {
    expect(replaceOutsideCode("plain text", /zzz/g, upper)).toBe("plain text");
  });
});

describe("codeSegmentRanges / isInsideCode", () => {
  it("reports each code segment's [from,to)", () => {
    const src = "ab `cd` ef `gh`";
    const r = codeSegmentRanges(src);
    expect(r).toEqual([
      { from: 3, to: 7 },
      { from: 11, to: 15 },
    ]);
    expect(src.slice(r[0]!.from, r[0]!.to)).toBe("`cd`");
  });
  it("isInsideCode is true only for an overlapping range", () => {
    const r = codeSegmentRanges("xx `yy` zz");
    expect(isInsideCode(r, 4, 6)).toBe(true); // inside `yy`
    expect(isInsideCode(r, 0, 2)).toBe(false); // before
    expect(isInsideCode(r, 8, 10)).toBe(false); // after
  });
  it("an unterminated inline span (no closing backtick) yields no range", () => {
    expect(codeSegmentRanges("text `unterminated here")).toEqual([]);
  });
  it("a bare ``` (no closing fence) is matched as an empty inline span, harmlessly", () => {
    // The inline `...` arm matches the first two backticks as an empty
    // code span — a quirk inherited from math-preview.ts's regex; it
    // protects nothing meaningful, which is fine.
    expect(codeSegmentRanges("``` open forever")).toEqual([{ from: 0, to: 2 }]);
  });
});

it("CODE_SEGMENT_RE matches the math-preview shape", () => {
  expect(CODE_SEGMENT_RE.source).toBe("(```[\\s\\S]*?```|`[^`\\n]*`)");
});
