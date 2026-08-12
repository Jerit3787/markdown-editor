import { describe, it, expect } from "vitest";
import { extractMathSpans } from "./math-preview";

describe("extractMathSpans", () => {
  it("extracts inline math, replacing it with a placeholder marker", () => {
    const { text, sources } = extractMathSpans("The value is $x + y$ today.");
    expect(text).not.toContain("$x + y$");
    expect(text).toMatch(/^The value is §MATH\d+§ today\.$/);
    const [[, source]] = sources;
    expect(source).toEqual({ src: "x + y", display: false });
  });

  it("extracts block math spanning multiple lines", () => {
    const { text, sources } = extractMathSpans("Before\n$$\n\\sum_{i=1}^n i\n$$\nAfter");
    expect(text).not.toContain("$$");
    const [[, source]] = sources;
    expect(source.display).toBe(true);
    expect(source.src).toBe("\n\\sum_{i=1}^n i\n");
  });

  it("does not treat currency as math (whitespace touching the delimiter)", () => {
    const { text, sources } = extractMathSpans("It costs $5 and $10 total.");
    expect(text).toBe("It costs $5 and $10 total.");
    expect(sources.size).toBe(0);
  });

  it("does not treat a single stray dollar sign as math", () => {
    const { text, sources } = extractMathSpans("Just $5 here.");
    expect(text).toBe("Just $5 here.");
    expect(sources.size).toBe(0);
  });

  it("resolves block math before inline math, so $$..$$ isn't misread as nested inline math", () => {
    const { text, sources } = extractMathSpans("$$x^2$$");
    expect(text).toMatch(/^§MATH\d+§$/);
    expect(sources.size).toBe(1);
    const [[, source]] = sources;
    expect(source).toEqual({ src: "x^2", display: true });
  });

  it("leaves math-looking text inside a fenced code block untouched", () => {
    const input = "```\n$x + y$\n```";
    const { text, sources } = extractMathSpans(input);
    expect(text).toBe(input);
    expect(sources.size).toBe(0);
  });

  it("leaves math-looking text inside an inline code span untouched", () => {
    const { text, sources } = extractMathSpans("Use `$x$` for math.");
    expect(text).toBe("Use `$x$` for math.");
    expect(sources.size).toBe(0);
  });

  it("extracts multiple distinct math spans with distinct keys", () => {
    const { text, sources } = extractMathSpans("$a$ and $b$");
    expect(sources.size).toBe(2);
    const values = [...sources.values()];
    expect(values).toEqual([
      { src: "a", display: false },
      { src: "b", display: false },
    ]);
    const keys = [...sources.keys()];
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(text).toContain(`§${key}§`);
  });

  it("returns no matches for markdown with no math", () => {
    const { text, sources } = extractMathSpans("Just plain *markdown* text.");
    expect(text).toBe("Just plain *markdown* text.");
    expect(sources.size).toBe(0);
  });
});
