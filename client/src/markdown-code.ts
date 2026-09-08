// Splits markdown text on code regions so a pre-parse transform never
// touches sample syntax the user typed inside `code` or a ```fence```.
// Hand-mirrored as src/markdown-code.ts for the Worker (client and Worker
// code don't cross-import in this repo) — same convention as
// wikilink-rewrite.ts / version-grouping.ts.
//
// Scope: fenced ```...``` (across lines) and inline `...` (one line).
// Indented 4-space code blocks and unbalanced backticks are NOT handled
// — a known limitation shared with math-preview.ts, which consumes
// CODE_SEGMENT_RE from here.
export const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

// String.prototype.replace's function form, but only over the parts of
// `text` outside a code segment. Splitting on a *capturing* regex
// interleaves the code segments at odd indices — left verbatim.
export function replaceOutsideCode(text: string, pattern: RegExp, replacer: (match: string, ...groups: string[]) => string): string {
  return text
    .split(CODE_SEGMENT_RE)
    .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(pattern, replacer as (substring: string, ...args: unknown[]) => string)))
    .join("");
}

// Absolute [from, to) of every code segment, in document order.
export function codeSegmentRanges(text: string): Array<{ from: number; to: number }> {
  const re = new RegExp(CODE_SEGMENT_RE.source, "g");
  const ranges: Array<{ from: number; to: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    ranges.push({ from: m.index, to: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return ranges;
}

export function isInsideCode(ranges: Array<{ from: number; to: number }>, from: number, to: number): boolean {
  return ranges.some((r) => from < r.to && to > r.from);
}
