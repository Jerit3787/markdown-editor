import { Marked, type Tokens } from "marked";

// A dedicated Marked instance, deliberately isolated from the app's
// shared `marked` singleton (which has marked-footnote registered).
// marked-footnote keeps mutable closure state (a hasFootnotes flag) on
// whatever instance it's registered on, shared across every .lexer()/
// .parse() call on that instance; walkTokens (which resets the flag)
// only runs during .parse(), never .lexer(). Calling the shared
// singleton's .lexer() here — once per keystroke, ahead of
// updatePreview()'s own .parse() call — left that flag set and broke
// the very next .parse() call's footnote handling. This function only
// needs plain block-token boundaries, no footnote-aware behavior, so an
// unextended instance sidesteps the shared state entirely.
const lexerOnly = new Marked();

// Runs on the *original*, unextracted raw markdown — never the text
// after extractMathSpans() has substituted $$...$$ block math with a
// single-line placeholder, which would corrupt every line number after
// it. marked's lexer has no special knowledge of $$ math on the
// original text; it just sees a blank-line-delimited chunk and treats
// it as one top-level token already, which is exactly the block
// boundary this needs — no math-awareness required here at all.
export function computeBlockLineStarts(raw: string): number[] {
  const tokens = lexerOnly.lexer(raw);
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

// Parallel to computeBlockLineStarts (same order, same "space"-token
// skip, one entry per returned block) — for each top-level block, the
// start line of each of its own list items if the block is a list, or
// null otherwise.
//
// Why this matters: app.ts's followCursorInPreview() interpolates the
// cursor's fractional pixel position within a whole block's editor
// rendering onto that same fraction of the block's preview rendering.
// That's only accurate if lines are roughly uniform height throughout
// the block — true enough for a paragraph, but not for a list of any
// real size: the editor's fixed-width font and the preview's
// proportional font wrap each item differently, so a list's per-item
// line-density in the editor and in the preview diverge more with
// every item, not just once per block. A long list previously had only
// one anchor (its own start line) for the interpolation to work with;
// tagging each item's own start line gives it one anchor per item
// instead, the same fix computeBlockLineStarts already applies at the
// whole-block level, just one level deeper.
export function computeListItemLineStarts(raw: string): (number[] | null)[] {
  const tokens = lexerOnly.lexer(raw);
  const result: (number[] | null)[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.type !== "space") {
      if (token.type === "list") {
        const itemLines: number[] = [];
        let itemCursor = cursor;
        for (const item of (token as Tokens.List).items) {
          itemLines.push(raw.slice(0, itemCursor).split("\n").length - 1);
          itemCursor += item.raw.length;
        }
        result.push(itemLines);
      } else {
        result.push(null);
      }
    }
    cursor += token.raw.length;
  }
  return result;
}
