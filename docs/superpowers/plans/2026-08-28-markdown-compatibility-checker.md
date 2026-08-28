# Markdown Compatibility Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Compatibility" row to the Document Info panel that flags markdown constructs which won't render the same (or at all) outside this app.

**Architecture:** A pure, standalone scanner module (`markdown-compat.ts`) walks a fresh `marked` lexer's token tree — never raw-source regexing — so checks for GFM constructs (tables, task lists, strikethrough) and this app's own extensions (wikilinks, image/diagram references) never misfire inside code blocks or spans. `DocInfoPanel.svelte` wires the scanner's output into a new expandable row, reusing its own existing `.doc-info-backlink-row` click-to-jump pattern.

**Tech Stack:** `marked` v18 (`Marked` class, `.lexer()`), Svelte 5, Vitest (`unit` project — pure function, no DOM needed).

**Spec:** `docs/superpowers/specs/2026-08-28-markdown-compatibility-checker-design.md`

## Global Constraints

- Two categories only: `"app-only"` (wikilinks, image references, diagram references — breaks completely elsewhere) and `"flavor-specific"` (tables, strikethrough, task lists, math, footnote references, real Mermaid diagrams — renders here/GitHub, not guaranteed elsewhere).
- No auto-fix, no configurability, no checks beyond the seven listed constructs.
- Never scan inside a fenced code block or inline code span — use the `marked` lexer's own token tree, not raw-text regex, to guarantee this.
- The math check must not misfire on two dollar amounts in the same sentence (e.g. "It costs $5 and $10.") — use the Pandoc-style heuristic in Task 1, not a naive `\$[^$]+\$` regex.

---

### Task 1: `markdown-compat.ts` scanner module

**Files:**
- Create: `client/src/markdown-compat.ts`
- Test: `tests/client/src/markdown-compat.test.ts` (new, `unit` Vitest project)

**Interfaces:**
- Consumes: `marked`'s `Marked` class and `Token`/`Tokens` types (existing dependency, already used by `Preview.svelte`).
- Produces: `scanMarkdownCompatibility(text: string, images: Record<string, string> | undefined, diagrams: Record<string, string> | undefined): CompatIssue[]` and the `CompatIssue`/`CompatCategory` types — the only symbols Task 2 needs.

- [ ] **Step 1: Write the failing tests**

Create `tests/client/src/markdown-compat.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { scanMarkdownCompatibility } from "../../../client/src/markdown-compat";

describe("scanMarkdownCompatibility", () => {
  test("flags a wikilink as app-only", () => {
    const issues = scanMarkdownCompatibility("See [[Other Doc]] for details.", undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("app-only");
    expect(issues[0].label).toBe("Wikilink");
    expect("See [[Other Doc]] for details.".slice(issues[0].from, issues[0].to)).toBe("[[Other Doc]]");
  });

  test("flags an image reference (key present in images map) as app-only", () => {
    const text = "![pixel](pixel.png)";
    const issues = scanMarkdownCompatibility(text, { "pixel.png": "data:image/png;base64,AAAA" }, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("app-only");
    expect(issues[0].label).toBe("Image reference");
    expect(text.slice(issues[0].from, issues[0].to)).toBe(text);
  });

  test("a real external image URL is not flagged", () => {
    const issues = scanMarkdownCompatibility("![alt](https://example.com/pic.png)", undefined, undefined);
    expect(issues).toHaveLength(0);
  });

  test("flags a diagram reference (body key present in diagrams map) as app-only", () => {
    const text = "```mermaid\ndiagram\n```";
    const issues = scanMarkdownCompatibility(text, undefined, { diagram: "graph TD; A-->B" });
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("app-only");
    expect(issues[0].label).toBe("Diagram reference");
  });

  test("flags real inline Mermaid source as flavor-specific", () => {
    const text = "```mermaid\ngraph TD; A-->B\n```";
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Mermaid diagram");
  });

  test("flags a table as flavor-specific", () => {
    const text = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Table");
  });

  test("flags strikethrough as flavor-specific", () => {
    const issues = scanMarkdownCompatibility("This is ~~wrong~~ right.", undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Strikethrough");
  });

  test("flags a task list item as flavor-specific", () => {
    const issues = scanMarkdownCompatibility("- [ ] todo\n- not a task\n", undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Task list item");
  });

  test("flags a footnote reference as flavor-specific", () => {
    const issues = scanMarkdownCompatibility("Fact.[^1]\n\n[^1]: A note.", undefined, undefined);
    expect(issues.filter((i) => i.label === "Footnote reference")).toHaveLength(1);
    expect(issues.find((i) => i.label === "Footnote reference")?.category).toBe("flavor-specific");
  });

  test("flags inline and block math as flavor-specific", () => {
    const issues = scanMarkdownCompatibility("Inline $x + y$ and block:\n\n$$E = mc^2$$", undefined, undefined);
    const math = issues.filter((i) => i.label === "Math");
    expect(math).toHaveLength(2);
    expect(math.every((i) => i.category === "flavor-specific")).toBe(true);
  });

  test("two dollar amounts in prose are not flagged as math", () => {
    const issues = scanMarkdownCompatibility("It costs $5 and $10.", undefined, undefined);
    expect(issues.filter((i) => i.label === "Math")).toHaveLength(0);
  });

  test("nothing inside a fenced code block or inline code span is flagged", () => {
    const text = ["```", "~~not strikethrough~~", "[[not a wikilink]]", "```", "", "Also `$not math$` here."].join("\n");
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    expect(issues).toHaveLength(0);
  });

  test("issues are sorted by ascending position", () => {
    const text = "$x$ then ~~y~~ then [[Z]]";
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    for (let i = 1; i < issues.length; i++) {
      expect(issues[i].from).toBeGreaterThanOrEqual(issues[i - 1].from);
    }
  });

  test("a clean document has no issues", () => {
    const issues = scanMarkdownCompatibility("# Heading\n\nJust a normal paragraph.\n", undefined, undefined);
    expect(issues).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/markdown-compat.test.ts`
Expected: FAIL — `client/src/markdown-compat.ts` doesn't exist yet, so the import fails to resolve.

- [ ] **Step 3: Write the scanner module**

Create `client/src/markdown-compat.ts`:

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
        issues.push({ category: "flavor-specific", label: "Strikethrough", from: absoluteStart, to: absoluteStart + t.raw.length });
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

    if ("tokens" in token) {
      walkInline((token as { tokens?: Token[] }).tokens, token.raw, start);
    }
  }

  return issues.sort((a, b) => a.from - b.from);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/markdown-compat.test.ts`
Expected: PASS (all 13 tests).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add client/src/markdown-compat.ts tests/client/src/markdown-compat.test.ts
git commit -m "feat: add a markdown compatibility scanner"
```

---

### Task 2: Wire into Document Info panel, styles, version/changelog/whats-new, final verification

**Files:**
- Modify: `client/src/components/DocInfoPanel.svelte`
- Modify: `client/src/styles/_diff-view.scss` (this is where the existing `.doc-info-*` rules actually live, not `_modals.scss`)
- Modify: `package.json`, `package-lock.json` (two `"version"` fields)
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `IMPROVEMENTS.md`
- Create: `client/public/whats-new/markdown-compatibility-checker.png`

**Interfaces:**
- Consumes: `scanMarkdownCompatibility`, `CompatIssue`, `CompatCategory` from Task 1.
- Produces: nothing new for other code — this task's UI wiring is the final consumer in this plan.

- [ ] **Step 1: Add the import and derived state**

In `client/src/components/DocInfoPanel.svelte`, add a new import directly after the existing `import { fetchRepoDocDates, type RepoDocDates } from "../repo-doc-dates";` line:

```ts
import { scanMarkdownCompatibility, type CompatIssue } from "../markdown-compat";
```

Add new state directly after the existing `const charCount = $derived($activeDocContent.length);` line:

```ts
const compatIssues = $derived.by(() => (doc ? scanMarkdownCompatibility($activeDocContent, doc.images, doc.diagrams) : []));
let compatExpanded = $state(false);
```

Add a new module-level constant directly after the existing imports (this avoids embedding an `as const`-asserted array literal inside the template's `{#each}` expression below, where a second `as` keyword risks ambiguity with Svelte's own `{#each ... as item}` syntax):

```ts
const COMPAT_CATEGORIES = ["app-only", "flavor-specific"] as const;
```

Add a new function directly after the existing `jumpTo` function:

```ts
function jumpToIssue(issue: CompatIssue) {
  const cm = window.MDE.getEditor();
  cm.dispatch({ selection: { anchor: issue.from, head: issue.to }, scrollIntoView: true });
  cm.focus();
  close();
}
```

- [ ] **Step 2: Add the template row**

In the template, add directly after the existing "Length" row's closing `</div>` (immediately before the `{#if doc.repoPath || doc.gistId}` line):

```svelte
<div class="doc-info-row">
  <span class="doc-info-primary">Compatibility</span>
  <button type="button" class="doc-info-secondary doc-info-link" onclick={() => (compatExpanded = !compatExpanded)}>
    {compatIssues.length === 0 ? "No issues" : `${compatIssues.length} issue${compatIssues.length === 1 ? "" : "s"}`}
  </button>
</div>
{#if compatExpanded && compatIssues.length > 0}
  <div class="doc-info-compat-list">
    {#each COMPAT_CATEGORIES as category}
      {@const categoryIssues = compatIssues.filter((i) => i.category === category)}
      {#if categoryIssues.length > 0}
        <div class="doc-info-compat-category">
          {category === "app-only" ? "App-only (won't render elsewhere at all)" : "Flavor-specific (works here and on GitHub, not guaranteed elsewhere)"}
        </div>
        {#each categoryIssues as issue}
          <button type="button" class="doc-info-backlink-row" onclick={() => jumpToIssue(issue)}>{issue.label}</button>
        {/each}
      {/if}
    {/each}
  </div>
{/if}
```

- [ ] **Step 3: Add the new CSS rules**

In `client/src/styles/_diff-view.scss`, add directly after the existing `.doc-info-link:hover, .doc-info-link:focus-visible { ... }` block:

```scss
.doc-info-compat-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.doc-info-compat-category {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-dim);
  margin: 8px 0 2px;
}
```

- [ ] **Step 4: Run typecheck and the full unit/component suite**

Run: `npm run typecheck && npm test`
Expected: both pass with no new errors or warnings.

- [ ] **Step 5: Manual verification**

Run `npm run build && npm run dev:client`, open the app, type a document containing a table, `~~strikethrough~~`, a `- [ ]` task item, `$x + y$`, `[^1]` with its `[^1]: definition`, a `[[Wikilink]]` (to a document that doesn't exist yet, so it renders as a "missing" link — irrelevant to this check), and (via the toolbar's image button) upload an image so a real `![alt](key)` reference exists. Open Document Info (the topbar's info icon or File menu): confirm the "Compatibility" row shows the correct count, click it to expand, confirm both category headers appear with the right items grouped underneath, and click a few entries to confirm the editor selection jumps to the right span and the panel closes.

- [ ] **Step 6: Bump the version**

Read the current version from `package.json` first (it may have changed since this plan was written). Bump the minor version in both `package.json` and **both** `"version"` fields in `package-lock.json`.

- [ ] **Step 7: Add the CHANGELOG entry**

Add a new section to `CHANGELOG.md`, directly above the current top entry, using the version bumped in Step 6 and today's date:

```markdown
## [<NEW_VERSION>] - 2026-08-28

### Added

- **Markdown compatibility checker.** The Document Info panel now has a "Compatibility" row that flags markdown constructs which won't render the same elsewhere — wikilinks, image/diagram references (app-only, won't render at all outside this editor), and GFM/KaTeX extensions like tables, strikethrough, task lists, math, and footnotes (flavor-specific, fine here and on GitHub, not guaranteed on a stricter renderer). Click any flagged item to jump straight to it in the editor.
```

- [ ] **Step 8: Capture the What's New screenshot**

Using the same throwaway-Playwright-script technique used for prior features in this session (seed a local doc via `localStorage`, navigate to `/d/<id>`, set the editor's content via `window.MDE.getEditor().dispatch(...)` to a document containing a few of the flagged constructs, open Document Info, click the Compatibility row to expand it), screenshot the expanded panel showing both category groups with real flagged items at roughly 1200×630. Save to `client/public/whats-new/markdown-compatibility-checker.png`.

- [ ] **Step 9: Add the What's New entry**

Append to the end of the `WHATS_NEW_ENTRIES` array in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "<NEW_VERSION>",
    title: "Markdown Compatibility Checker",
    description:
      "Document Info now has a Compatibility row that flags constructs which won't render the same elsewhere — wikilinks and image/diagram references that are app-only, plus GFM/math extensions that work here and on GitHub but aren't guaranteed everywhere. Click any flagged item to jump right to it.",
    screenshot: "/whats-new/markdown-compatibility-checker.png",
  },
```

- [ ] **Step 10: Check off the IMPROVEMENTS.md item**

Change:

```markdown
- [ ] Support all flavors of Markdown (CommonMark, GFM, MultiMarkdown,
      etc.) and add a Markdown compatibility checker under the
      Document Info panel — flag syntax that's flavor-specific or
      won't render the same elsewhere.
```

to:

```markdown
- [x] Markdown compatibility checker. (Shipped v<NEW_VERSION> as a
      Document Info panel row flagging app-only and flavor-specific
      syntax. "Support all flavors of Markdown" was descoped — it's a
      separate, much larger effort that overlaps the still-open
      MultiMarkdown syntax support item below.)
```

- [ ] **Step 11: Run final verification suite**

Run in order:

```bash
npm run typecheck
npm run format:check
npm test
npm run build
```

Expected: all green. If `format:check` fails, run `npm run format` and re-check.

- [ ] **Step 12: Commit**

```bash
git add client/src/components/DocInfoPanel.svelte client/src/styles/_diff-view.scss package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts IMPROVEMENTS.md client/public/whats-new/markdown-compatibility-checker.png
git commit -m "feat: surface markdown compatibility issues in Document Info"
```
