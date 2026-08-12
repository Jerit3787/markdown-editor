import { marked } from "marked";

// Runs on the *original*, unextracted raw markdown — never the text
// after extractMathSpans() has substituted $$...$$ block math with a
// single-line placeholder, which would corrupt every line number after
// it. marked's lexer has no special knowledge of $$ math on the
// original text; it just sees a blank-line-delimited chunk and treats
// it as one top-level token already, which is exactly the block
// boundary this needs — no math-awareness required here at all.
export function computeBlockLineStarts(raw: string): number[] {
  const tokens = marked.lexer(raw);
  const lineStarts: number[] = [];
  let cursor = 0;
  for (const token of tokens) {
    // "space" tokens are blank-line gaps between blocks and never
    // render into their own DOM element — skip them when recording
    // block starts, but still advance the cursor past them.
    if (token.type !== "space") {
      const linesBefore = raw.slice(0, cursor).split("\n").length - 1;
      lineStarts.push(linesBefore);
    }
    cursor += token.raw.length;
  }
  return lineStarts;
}
