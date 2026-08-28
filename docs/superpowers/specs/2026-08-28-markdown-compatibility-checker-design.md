# Markdown Compatibility Checker — Design Spec

**IMPROVEMENTS.md Phase 2 item:** "Support all flavors of Markdown (CommonMark, GFM, MultiMarkdown, etc.) and add a Markdown compatibility checker under the Document Info panel — flag syntax that's flavor-specific or won't render the same elsewhere."

## Scope decomposition

This backlog item bundles two unrelated pieces of work. Confirmed with the user: this spec covers only the second one.

- ~~"Support all flavors of Markdown"~~ — out of scope. This would mean the editor's own renderer gaining every dialect's syntax extensions (definition lists, critic markup, YAML frontmatter, etc.) — large enough to be its own project, and it substantially overlaps the separate, still-open "MultiMarkdown syntax support" IMPROVEMENTS.md item. Left for that item whenever it's picked up.
- **"A Markdown compatibility checker that flags flavor-specific syntax"** — this spec's actual scope: a static scan of the active document that flags constructs which won't render the same (or at all) outside this app, surfaced in the Document Info panel.

This app renders with `marked` in GFM mode plus the `marked-footnote` plugin (`client/src/components/Preview.svelte`) — confirmed via `marked.parse(extractedRaw, { gfm: true, breaks: false, renderer })` and `marked.use(markedFootnote(...))`. It also has three syntax extensions of its own, layered on top via pre/post-processing rather than real markdown syntax: `[[Wikilinks]]` (`wikilinks.ts`), image references `![alt](key)` where `key` is a lookup into `doc.images` rather than a URL (`app.ts`'s `resolveImageRefs`), and diagram references — a ` ```mermaid ` fence whose one-line body is a lookup key into `doc.diagrams` rather than real Mermaid source (`diagram-refs.ts`'s `resolveDiagramRefs`).

## Goal

A new "Compatibility" row in the Document Info panel (`DocInfoPanel.svelte`) shows a live issue count for the active document (e.g., "3 issues" / "No compatibility issues"); clicking it expands an in-place list of every flagged construct, grouped into two categories, each entry clickable to jump the editor's selection to that exact span (mirroring `CommentsPanel.svelte`'s existing `jumpTo()` pattern) and close the panel.

**Category: App-only** — breaks completely outside this app, not just "renders differently":
- **Wikilink** — `[[Name]]`
- **Image reference** — `![alt](key)` where `key` resolves through the active document's `images` map
- **Diagram reference** — a ` ```mermaid ` fence whose body is a key into the active document's `diagrams` map

**Category: Flavor-specific** — renders fine here (and on GitHub/other GFM-aware tools), not guaranteed on a stricter CommonMark renderer or a different platform:
- **Table**
- **Strikethrough** — `~~text~~`
- **Task list item** — `- [ ]` / `- [x]`
- **Math** — `$...$` / `$$...$$` (KaTeX-only, not in any markdown spec)
- **Footnote reference** — `[^label]`
- **Mermaid diagram** — a ` ```mermaid ` fence with real inline source (renders as a diagram here/GitHub, shows as a plain code block on a renderer that doesn't special-case the language)

## Non-goals (deferred)

- **No "support all flavors" rendering work** — see Scope decomposition above.
- **No auto-fix action.** The panel only surfaces and locates issues; rewriting flagged syntax into something more portable is a manual editing task for the user.
- **No configurability** (e.g., "don't flag math," a target-flavor picker). Every check always runs; the two-category grouping is the only structure.
- **No check for anything beyond the seven listed constructs.** Other real cross-flavor differences exist (e.g., raw HTML blocks, certain heading-underline styles) but aren't in scope for this first pass.

## Components

### `client/src/markdown-compat.ts` (new)

Pure module, no Svelte/store dependencies — a fresh `Marked` instance (not the app's shared `marked` singleton `Preview.svelte` mutates via `.use(markedFootnote(...))`) is created locally so this module's lexing behavior never depends on module-load order elsewhere in the app, and so `[^label]`/math/wikilink syntax reliably falls through to plain `text` tokens (no footnote extension registered) for the regex-based checks below to scan.

```ts
import { Marked } from "marked";
import type { Token, Tokens } from "marked";

export type CompatCategory = "app-only" | "flavor-specific";

export interface CompatIssue {
  category: CompatCategory;
  label: string;
  from: number;
  to: number;
}

const compatLexer = new Marked({ gfm: true });

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
// Bare `\$[^$\n]+\$` would greedily misread "It costs $5 and $10" as one
// inline-math span (both dollar signs, everything between them). The
// single-`$` alternative below borrows Pandoc's own tex_math_dollars
// heuristic instead: neither delimiter may touch whitespace, and the
// closing `$` may not be immediately followed by a digit — which is
// exactly what defeats the "$5 and $10" case (the character right before
// the second `$` is a space, so it can never be read as this pattern's
// closing delimiter), while still matching real math like `$x + y$`.
const MATH_RE = /\$\$[^$]+\$\$|(?<![\d$])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/g;

export function scanMarkdownCompatibility(text: string, images: Record<string, string> | undefined, diagrams: Record<string, string> | undefined): CompatIssue[] {
  const issues: CompatIssue[] = [];
  const tokens = compatLexer.lexer(text);
  let cursor = 0;

  function findAbsolute(raw: string, from: number): number {
    const idx = text.indexOf(raw, from);
    return idx === -1 ? from : idx;
  }

  function scanTextToken(raw: string, start: number) {
    for (const re of [WIKILINK_RE, FOOTNOTE_REF_RE, MATH_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw))) {
        const label = re === WIKILINK_RE ? "Wikilink" : re === FOOTNOTE_REF_RE ? "Footnote reference" : "Math";
        const category: CompatCategory = re === WIKILINK_RE ? "app-only" : "flavor-specific";
        issues.push({ category, label, from: start + m.index, to: start + m.index + m[0].length });
      }
    }
  }

  // Walks a block token's own inline-token tree (paragraphs, headings,
  // table cells, list items) looking for `image`/`del`/`text` tokens —
  // codespan/code tokens are never recursed into, which is what keeps
  // `~~not strikethrough~~` or `$5` typed *inside* a code span or fence
  // from ever reaching the checks above.
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
        issues.push({ category: "flavor-specific", label: "Strikethrough", from: absoluteStart, to: absoluteStart + t.raw.length });
      } else if (t.type === "text") {
        scanTextToken(t.raw, absoluteStart);
      }
      // Recurse into any inline token that itself carries nested inline
      // tokens (e.g. emphasis wrapping a wikilink) — codespan tokens
      // have no `.tokens`, so they're naturally excluded here.
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
      // cell's own indexOf search starts fresh from 0 within the table's
      // raw text rather than tracking a running cursor across cells, so
      // two cells with byte-identical content (e.g. two cells both
      // reading "$x$") can both resolve to the first cell's offset —
      // clicking the second issue would jump to the first cell instead.
      // Accepted as a known, cosmetic-only limitation for this first pass.
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

    // paragraph, heading, blockquote, etc. — all carry a flat `.tokens`
    // inline-token array over the block's own raw text.
    if ("tokens" in token) {
      walkInline((token as { tokens?: Token[] }).tokens, token.raw, start);
    }
  }

  return issues.sort((a, b) => a.from - b.from);
}
```

### `client/src/components/DocInfoPanel.svelte` (modify)

New import and derived state, alongside the existing `wordCount`/`charCount`:

```ts
import { scanMarkdownCompatibility, type CompatIssue } from "../markdown-compat";
```

```ts
const compatIssues = $derived.by(() => (doc ? scanMarkdownCompatibility($activeDocContent, doc.images, doc.diagrams) : []));
let compatExpanded = $state(false);

function jumpToIssue(issue: CompatIssue) {
  const cm = window.MDE.getEditor();
  cm.dispatch({ selection: { anchor: issue.from, head: issue.to }, scrollIntoView: true });
  cm.focus();
  close();
}
```

No debounce scheduler needed: `DocInfoPanel` only exists in the DOM while `$docInfoPanelOpen` is true (`{#if $docInfoPanelOpen && doc}`), and `Modal.svelte`'s full-screen backdrop blocks interaction with the editor behind it — so `compatIssues` recomputes reactively (via `$activeDocContent`) only in response to state changes that can actually happen while the panel is open (switching documents), never on every keystroke of a document being actively typed in elsewhere, because that can't happen while this modal is open.

Template addition, as a new row after the existing "Length" row:

```svelte
<div class="doc-info-row">
  <span class="doc-info-primary">Compatibility</span>
  <button type="button" class="doc-info-secondary doc-info-link" onclick={() => (compatExpanded = !compatExpanded)}>
    {compatIssues.length === 0 ? "No issues" : `${compatIssues.length} issue${compatIssues.length === 1 ? "" : "s"}`}
  </button>
</div>
{#if compatExpanded && compatIssues.length > 0}
  <div class="doc-info-compat-list">
    {#each ["app-only", "flavor-specific"] as const as category}
      {@const categoryIssues = compatIssues.filter((i) => i.category === category)}
      {#if categoryIssues.length > 0}
        <div class="doc-info-compat-category">{category === "app-only" ? "App-only (won't render elsewhere at all)" : "Flavor-specific (works here and on GitHub, not guaranteed elsewhere)"}</div>
        {#each categoryIssues as issue}
          <button type="button" class="doc-info-backlink-row" onclick={() => jumpToIssue(issue)}>{issue.label}</button>
        {/each}
      {/if}
    {/each}
  </div>
{/if}
```

`.doc-info-backlink-row` is the existing class the panel's backlinks list already uses — reused verbatim for the same "clickable row that jumps somewhere" visual treatment. `.doc-info-compat-list`/`.doc-info-compat-category` are new, minimal rules (indentation + a small uppercase label) added to `client/src/styles/_modals.scss` next to the panel's other `doc-info-*` rules.

## Testing

New `tests/client/src/markdown-compat.test.ts` (`unit` Vitest project — pure function, no DOM/Svelte needed):

- One test per check: a minimal document containing exactly that construct produces exactly one issue with the expected `category`/`label`, and its `from`/`to` slice of the source string equals the construct's own raw text.
- **Code-fence exclusion:** a document with `~~not strikethrough~~`, `` `$not math$` ``, and `[[not a wikilink]]` each placed inside a fenced code block or inline code span produces zero issues — this is the test that actually proves the lexer-based approach over naive regex-on-raw-text.
- **Two dollar amounts aren't math:** `"It costs $5 and $10."` produces zero issues (proves the Pandoc-style heuristic actually defeats the classic false positive a naive `\$[^$]+\$` regex would produce here).
- **Image reference vs. real image:** `![alt](pixel.png)` with `images: { "pixel.png": "data:..." }` flags "Image reference"; the same markdown with `images: undefined` (or a `images` map that doesn't contain `"pixel.png"`) produces no issue for it (a normal external image URL isn't a compatibility problem).
- **Diagram reference vs. real Mermaid:** a ` ```mermaid ` fence containing `diagram` as its only line, with `diagrams: { diagram: "graph TD; A-->B" }`, flags "Diagram reference"; a ` ```mermaid ` fence containing real Mermaid source (`graph TD; A-->B`) directly flags "Mermaid diagram" instead.
- **Multiple issues sorted by position:** a document with several different constructs in a scrambled order returns issues sorted by ascending `from`.
- **Clean document:** plain prose with a heading and an ordinary paragraph produces zero issues.

New `tests/client/src/components/DocInfoPanel.test.ts` is not added — this repo has no existing component test for `DocInfoPanel.svelte` today (its behavior is exercised only by manual use), and this spec's UI change is a thin, directly-readable wire-up of an already-fully-tested pure function into an existing template pattern (`.doc-info-backlink-row`) — consistent with how the panel's existing `wordCount`/`charCount`/backlinks logic has no dedicated component test either.
