import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import { DEFLIST_GROUP_RE, SUPERSCRIPT_RE } from "./mmd-inline-blocks";
import { PANDOC_CITATION_RE, MULTIMARKDOWN_CITATION_RE } from "./mmd-citations";

export type CompatCategory = "app-only" | "flavor-specific";

export interface CompatIssue {
  category: CompatCategory;
  label: string;
  from: number;
  to: number;
}

// A dedicated, unextended instance — never the app's shared `marked`
// singleton `Preview.svelte` mutates via `.use(markedFootnote(...))` —
// so this module's lexing never depends on module-load order elsewhere,
// and `[^label]` reliably falls through to a plain `text` token (no
// footnote extension registered) for the regex below to catch.
const compatLexer = new Marked({ gfm: true });

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
// Bare `\$[^$\n]+\$` would greedily misread "It costs $5 and $10" as one
// inline-math span. The single-`$` alternative below borrows Pandoc's
// own tex_math_dollars heuristic: neither delimiter may touch
// whitespace, and the closing `$` may not be immediately followed by a
// digit — the character right before the second `$` in "$5 and $10" is
// a space, so it can never satisfy this pattern's closing delimiter,
// while `$x + y$` still matches correctly.
const MATH_RE = /\$\$[^$]+\$\$|(?<![\d$])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/g;

export function scanMarkdownCompatibility(
  text: string,
  images: Record<string, string> | undefined,
  diagrams: Record<string, string> | undefined,
): CompatIssue[] {
  const issues: CompatIssue[] = [];
  const tokens = compatLexer.lexer(text);
  let cursor = 0;

  function findAbsolute(raw: string, from: number): number {
    const idx = text.indexOf(raw, from);
    return idx === -1 ? from : idx;
  }

  function scanTextToken(raw: string, start: number) {
    for (const re of [WIKILINK_RE, FOOTNOTE_REF_RE, MATH_RE, SUPERSCRIPT_RE, PANDOC_CITATION_RE, MULTIMARKDOWN_CITATION_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw))) {
        const label =
          re === WIKILINK_RE
            ? "Wikilink"
            : re === FOOTNOTE_REF_RE
              ? "Footnote reference"
              : re === MATH_RE
                ? "Math"
                : re === SUPERSCRIPT_RE
                  ? "Superscript"
                  : "Citation";
        const category: CompatCategory = re === WIKILINK_RE ? "app-only" : "flavor-specific";
        issues.push({ category, label, from: start + m.index, to: start + m.index + m[0].length });
      }
    }
  }

  // Walks a block token's own inline-token tree (paragraphs, headings,
  // table cells, list items) looking for `image`/`del`/`text` tokens —
  // `codespan` tokens carry no `.tokens`, so they're never recursed
  // into, which is what keeps `~~not strikethrough~~` or `$5` typed
  // *inside* a code span from ever reaching the checks above.
  function walkInline(inlineTokens: Token[] | undefined, blockRaw: string, blockStart: number) {
    if (!inlineTokens) return;
    for (const t of inlineTokens) {
      const relative = blockRaw.indexOf(t.raw);
      const absoluteStart = relative === -1 ? blockStart : blockStart + relative;
      if (t.type === "image") {
        const img = t as Tokens.Image;
        if (images && Object.prototype.hasOwnProperty.call(images, img.href)) {
          issues.push({ category: "app-only", label: "Image reference", from: absoluteStart, to: absoluteStart + t.raw.length });
        }
      } else if (t.type === "del") {
        // marked's own del-tokenizer accepts a single tilde as well as the
        // real GFM double-tilde delimiter (verified empirically against
        // this exact installed marked version) — a genuine MultiMarkdown
        // subscript span ("H~2~O") is therefore already isolated as its
        // own `del` token by the time it reaches here, never as literal
        // text a SUPERSCRIPT_RE-style regex could scan for. Distinguish
        // the two by how many tildes the token's own raw text starts
        // with, rather than trying to regex-match subscript out of a text
        // token it can never actually appear in.
        const isSubscript = !t.raw.startsWith("~~");
        issues.push({ category: "flavor-specific", label: isSubscript ? "Subscript" : "Strikethrough", from: absoluteStart, to: absoluteStart + t.raw.length });
      } else if (t.type === "text") {
        scanTextToken(t.raw, absoluteStart);
      }
      if ("tokens" in t && Array.isArray((t as { tokens?: Token[] }).tokens)) {
        walkInline((t as { tokens?: Token[] }).tokens, blockRaw, blockStart);
      }
    }
  }

  for (const token of tokens) {
    const start = findAbsolute(token.raw, cursor);
    cursor = start + token.raw.length;

    if (token.type === "code") {
      const code = token as Tokens.Code;
      if (code.lang?.trim() === "mermaid") {
        const isRef = !!diagrams && Object.prototype.hasOwnProperty.call(diagrams, code.text.trim());
        issues.push({
          category: isRef ? "app-only" : "flavor-specific",
          label: isRef ? "Diagram reference" : "Mermaid diagram",
          from: start,
          to: start + token.raw.length,
        });
      }
      continue; // never scan inside any code fence for anything else
    }

    if (token.type === "table") {
      issues.push({ category: "flavor-specific", label: "Table", from: start, to: start + token.raw.length });
      // Table cells can still contain inline wikilinks/math/etc. Each
      // cell's own indexOf search starts fresh within the table's raw
      // text rather than tracking a running cursor across cells, so two
      // cells with byte-identical content can both resolve to the first
      // cell's offset — accepted as a cosmetic-only limitation.
      const table = token as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()]) {
        walkInline(cell.tokens, token.raw, start);
      }
      continue;
    }

    if (token.type === "list") {
      const list = token as Tokens.List;
      for (const item of list.items) {
        if (item.task) {
          const itemStart = findAbsolute(item.raw, start);
          issues.push({ category: "flavor-specific", label: "Task list item", from: itemStart, to: itemStart + item.raw.length });
        }
        walkInline(item.tokens, token.raw, start);
      }
      continue;
    }

    if (token.type === "paragraph") {
      DEFLIST_GROUP_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DEFLIST_GROUP_RE.exec(token.raw))) {
        issues.push({ category: "flavor-specific", label: "Definition list", from: start + m.index, to: start + m.index + m[0].length });
      }
      walkInline((token as { tokens?: Token[] }).tokens, token.raw, start);
      continue;
    }

    if ("tokens" in token) {
      walkInline((token as { tokens?: Token[] }).tokens, token.raw, start);
    }
  }

  return issues.sort((a, b) => a.from - b.from);
}
