import { marked } from "marked";

// Term
// Term 2
// :   Definition A
// :   Definition B
//
// One or more consecutive non-indented "term" lines, followed by one or more
// ":"-prefixed definition lines. Consecutive term/definition groups (no
// intervening non-blank, non-matching line) merge into one <dl> — matching how
// adjacent list items already merge into one <ul>/<ol>.
// Exported (not just module-local) so markdown-compat.ts can detect the same
// shape it renders as, rather than a second, independently-drifting regex.
export const DEFLIST_GROUP_RE = /^((?:[^\s:][^\n]*\n)+)((?::[ \t]+[^\n]+\n?)+)/gm;
const DEFLIST_DEF_LINE_RE = /^:[ \t]+([^\n]+)$/gm;

export function transformDefinitionLists(text: string): string {
  return text.replace(DEFLIST_GROUP_RE, (_match, termLines: string, defLines: string) => {
    const terms = termLines
      .trim()
      .split("\n")
      .map((t) => `<dt>${marked.parseInline(t.trim())}</dt>`)
      .join("");
    const defs = [...defLines.matchAll(DEFLIST_DEF_LINE_RE)].map((m) => `<dd>${marked.parseInline(m[1]!.trim())}</dd>`).join("");
    return `<dl>${terms}${defs}</dl>\n\n`;
  });
}

// 2^10^ -> 2<sup>10</sup>. Neither delimiter may touch whitespace, and the
// opening "^" must not immediately follow "[" — a footnote reference's own
// caret ("[^label]") is always preceded by "[", so this single lookbehind is
// what keeps a footnote reference from ever being misread as superscript.
export const SUPERSCRIPT_RE = /(?<!\[)\^(?!\s)([^\s^]+?)(?<!\s)\^/g;
// H~2~O -> H<sub>2</sub>O. Must not fire inside a "~~text~~" GFM strikethrough
// span — resolved the same way math-preview.ts disambiguates $ from $$: match
// (and consume) "~~...~~" first via a non-capturing alternative so a single "~"
// inside it is never seen as a subscript delimiter on its own.
export const STRIKETHROUGH_OR_SUBSCRIPT_RE = /~~[^~\n]+~~|~(?!\s)([^\s~]+?)(?<!\s)~/g;

export function transformSuperscriptSubscript(text: string): string {
  const withSuperscript = text.replace(SUPERSCRIPT_RE, (_m, body: string) => `<sup>${marked.parseInline(body)}</sup>`);
  return withSuperscript.replace(STRIKETHROUGH_OR_SUBSCRIPT_RE, (m, body: string | undefined) =>
    body === undefined ? m : `<sub>${marked.parseInline(body)}</sub>`,
  );
}
