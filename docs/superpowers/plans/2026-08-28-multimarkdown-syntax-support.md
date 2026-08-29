# MultiMarkdown Syntax Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three MultiMarkdown syntax extensions to the editor — definition lists, superscript/subscript, and document metadata (as a structured, UI-edited field that round-trips as real `Key: Value` text on import/export) — plus Markdown Compatibility Checker coverage for the two that remain live editor-text syntax.

**Architecture:** Two new pure preprocessing/parsing modules (`mmd-inline-blocks.ts`, `mmd-metadata.ts`), wired into the existing `Preview.svelte` render pipeline (definition lists/superscript/subscript) and the existing `createDoc()`/export chokepoints (metadata) — no new architecture, everything follows patterns already established by `wikilinks.ts`, `math-preview.ts`, and the document-name sync on the Y.Doc `meta` map.

**Tech Stack:** TypeScript, Svelte 5, `marked` (for `marked.parseInline()`), Yjs (`Y.Map` sync), Vitest (`unit` + `components` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-28-multimarkdown-syntax-support-design.md`

## Global Constraints

- Definition lists: single-line terms/definitions only (no lazy continuation, no nested blocks); inline formatting inside a term/definition renders via `marked.parseInline()` (default renderer — no custom image/wikilink resolution inside a definition).
- Superscript (`^text^`) must never fire against a footnote reference (`[^label]`); subscript (`~text~`) must never fire inside a GFM strikethrough span (`~~text~~`).
- Metadata is a structured `Doc.metadata?: { key: string; value: string }[]` field, edited only via the Document Info panel UI — never inferred from live-typed editor text. It is parsed out of raw text exactly once, at the `createDoc()` import chokepoint, and serialized back to raw text only at export/publish/push time.
- Metadata syncs live for a shared document via the existing Y.Doc `meta` map (same mechanism as the document name), under a new `"metadata"` key holding a JSON-serialized array — no new top-level Y type, no server-side change.
- This is a user-facing feature: minor version bump (`1.X.0`), `CHANGELOG.md` entry, and a `whats-new-entries.ts` entry with a real screenshot.
- **Task ordering note:** `Doc.metadata` (types.ts) and the `MDEBridge` metadata hooks (types.ts) are deliberately added in two *different* tasks (Task 5 and Task 6) than where you might expect — Task 6 adds the `MDEBridge` interface members and their `app.ts` implementation together, in the same task, specifically so `npm run typecheck` never has an interim broken window across a task boundary. Don't split them further.

---

### Task 1: `mmd-inline-blocks.ts` — definition lists, superscript, subscript

**Files:**
- Create: `client/src/mmd-inline-blocks.ts`
- Test: `tests/client/src/mmd-inline-blocks.test.ts`

**Interfaces:**
- Produces: `transformDefinitionLists(text: string): string`, `transformSuperscriptSubscript(text: string): string`, and exported regex constants `DEFLIST_GROUP_RE`, `SUPERSCRIPT_RE`, `STRIKETHROUGH_OR_SUBSCRIPT_RE` (all consumed by Task 3's `markdown-compat.ts` changes).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/client/src/mmd-inline-blocks.test.ts
import { describe, it, expect } from "vitest";
import { transformDefinitionLists, transformSuperscriptSubscript } from "../../../client/src/mmd-inline-blocks";

describe("transformDefinitionLists", () => {
  it("converts a single term/definition pair", () => {
    const out = transformDefinitionLists("Apple\n:   A fruit\n");
    expect(out).toBe("<dl><dt>Apple</dt><dd>A fruit</dd></dl>\n\n");
  });

  it("converts multiple terms sharing one definition group", () => {
    const out = transformDefinitionLists("Apple\nFruit\n:   A red fruit\n:   Also a company\n");
    expect(out).toBe("<dl><dt>Apple</dt><dt>Fruit</dt><dd>A red fruit</dd><dd>Also a company</dd></dl>\n\n");
  });

  it("renders inline formatting inside a term and a definition", () => {
    const out = transformDefinitionLists("**Apple**\n:   A [fruit](https://example.com)\n");
    expect(out).toContain("<dt><strong>Apple</strong></dt>");
    expect(out).toContain('<dd>A <a href="https://example.com">fruit</a></dd>');
  });

  it("leaves ordinary paragraphs untouched", () => {
    const input = "Just a paragraph.\nWith a second line.\n";
    expect(transformDefinitionLists(input)).toBe(input);
  });

  it("leaves a term line with no following colon-line untouched", () => {
    const input = "Apple\nJust another line.\n";
    expect(transformDefinitionLists(input)).toBe(input);
  });
});

describe("transformSuperscriptSubscript", () => {
  it("converts superscript", () => {
    expect(transformSuperscriptSubscript("2^10^ is 1024")).toBe("2<sup>10</sup> is 1024");
  });

  it("converts subscript", () => {
    expect(transformSuperscriptSubscript("H~2~O is water")).toBe("H<sub>2</sub>O is water");
  });

  it("does not misread a footnote reference as superscript", () => {
    expect(transformSuperscriptSubscript("A claim.[^1]")).toBe("A claim.[^1]");
  });

  it("does not misread GFM strikethrough as subscript", () => {
    expect(transformSuperscriptSubscript("~~deleted text~~")).toBe("~~deleted text~~");
  });

  it("handles both strikethrough and subscript in the same line", () => {
    expect(transformSuperscriptSubscript("~~gone~~ but H~2~O stays")).toBe("~~gone~~ but H<sub>2</sub>O stays");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/mmd-inline-blocks.test.ts`
Expected: FAIL — `Cannot find module '../../../client/src/mmd-inline-blocks'`

- [ ] **Step 3: Implement `mmd-inline-blocks.ts`**

```ts
// client/src/mmd-inline-blocks.ts
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
  return withSuperscript.replace(STRIKETHROUGH_OR_SUBSCRIPT_RE, (m, body: string | undefined) => (body === undefined ? m : `<sub>${marked.parseInline(body)}</sub>`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/mmd-inline-blocks.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/mmd-inline-blocks.ts tests/client/src/mmd-inline-blocks.test.ts
git commit -m "feat: add MultiMarkdown definition-list and superscript/subscript transforms"
```

---

### Task 2: Wire `mmd-inline-blocks.ts` into `Preview.svelte`

**Files:**
- Modify: `client/src/components/Preview.svelte:8-15` (imports), `:79-81` (pipeline)
- Test: `tests/e2e/local/mmd-syntax.spec.ts` (new)

**Interfaces:**
- Consumes: `transformDefinitionLists`, `transformSuperscriptSubscript` from Task 1.

- [ ] **Step 1: Write the failing e2e test**

```ts
// tests/e2e/local/mmd-syntax.spec.ts
import { test, expect } from "./support/fixtures";

test("a definition list renders as a real <dl> in the preview", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("Apple\n:   A fruit");
  await expect(page.locator("#preview dt")).toHaveText("Apple");
  await expect(page.locator("#preview dd")).toHaveText("A fruit");
});

test("superscript and subscript render in the preview", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("2^10^ and H~2~O");
  await expect(page.locator("#preview sup")).toHaveText("10");
  await expect(page.locator("#preview sub")).toHaveText("2");
});

test("strikethrough and footnote references still render correctly alongside the new syntax", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("~~gone~~ and a claim.[^1]\n\n[^1]: A note.");
  await expect(page.locator("#preview del")).toHaveText("gone");
  await expect(page.locator("#preview sup a")).toBeVisible(); // footnote ref renders as a linked <sup>, not this feature's <sup>
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --project=local tests/e2e/local/mmd-syntax.spec.ts`
Expected: FAIL — `#preview dt`/`sup`/`sub` not found (raw `Apple\n:   A fruit` text shown instead)

- [ ] **Step 3: Wire the transforms into the pipeline**

In `client/src/components/Preview.svelte`, add to the import block (near line 12):

```ts
import { transformDefinitionLists, transformSuperscriptSubscript } from "../mmd-inline-blocks";
```

Change the pipeline (around line 79):

```ts
const { text: extractedRaw, sources } = extractMathSpans(transformWikilinks(raw));
currentMathSources = sources;
const html = marked.parse(extractedRaw, { gfm: true, breaks: false, renderer }) as string;
```

to:

```ts
const { text: extractedRaw, sources } = extractMathSpans(transformWikilinks(raw));
currentMathSources = sources;
const withInlineBlocks = transformSuperscriptSubscript(transformDefinitionLists(extractedRaw));
const html = marked.parse(withInlineBlocks, { gfm: true, breaks: false, renderer }) as string;
```

(Definition lists run before superscript/subscript so a term/definition's own inline content is available to `transformDefinitionLists`'s `marked.parseInline()` call before superscript/subscript syntax inside it would otherwise be double-processed — the two transforms don't interact, but this keeps the order deterministic and matches the module's own declaration order.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test --project=local tests/e2e/local/mmd-syntax.spec.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Run the full local Playwright suite to check for regressions**

Run: `npx playwright test --project=local`
Expected: PASS (all tests, no regressions — pay particular attention to `preview-rendering.spec.ts` and `formatting.spec.ts`'s math/footnote tests)

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Preview.svelte tests/e2e/local/mmd-syntax.spec.ts
git commit -m "feat: render MultiMarkdown definition lists and superscript/subscript in the preview"
```

---

### Task 3: Compatibility-checker coverage for definition lists, superscript, subscript

**Files:**
- Modify: `client/src/markdown-compat.ts`
- Test: `tests/client/src/markdown-compat.test.ts`

**Interfaces:**
- Consumes: `DEFLIST_GROUP_RE`, `SUPERSCRIPT_RE`, `STRIKETHROUGH_OR_SUBSCRIPT_RE` from Task 1.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/markdown-compat.test.ts` (alongside the existing per-check tests):

```ts
it("flags a definition list", () => {
  const issues = scanMarkdownCompatibility("Apple\n:   A fruit\n", undefined, undefined);
  expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Definition list" }));
});

it("flags superscript", () => {
  const issues = scanMarkdownCompatibility("2^10^ is 1024", undefined, undefined);
  expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Superscript" }));
});

it("flags subscript", () => {
  const issues = scanMarkdownCompatibility("H~2~O", undefined, undefined);
  expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Subscript" }));
});

it("does not double-flag strikethrough as subscript", () => {
  const issues = scanMarkdownCompatibility("~~deleted~~", undefined, undefined);
  const labels = issues.map((i) => i.label);
  expect(labels).toContain("Strikethrough");
  expect(labels).not.toContain("Subscript");
});

it("does not double-flag a footnote reference as superscript", () => {
  const issues = scanMarkdownCompatibility("A claim.[^1]\n\n[^1]: A note.", undefined, undefined);
  const labels = issues.map((i) => i.label);
  expect(labels).toContain("Footnote reference");
  expect(labels).not.toContain("Superscript");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/markdown-compat.test.ts`
Expected: FAIL — the 3 new "flags" tests fail (no such labels produced yet); the 2 disambiguation tests currently pass vacuously (fine, they'll still pass after the real implementation lands too).

- [ ] **Step 3: Implement**

Add the import near the top of `client/src/markdown-compat.ts`:

```ts
import { DEFLIST_GROUP_RE, SUPERSCRIPT_RE, STRIKETHROUGH_OR_SUBSCRIPT_RE } from "./mmd-inline-blocks";
```

In `scanTextToken`'s existing loop over `[WIKILINK_RE, FOOTNOTE_REF_RE, MATH_RE]`, add the two new regexes and their label/category logic:

```ts
function scanTextToken(raw: string, start: number) {
  for (const re of [WIKILINK_RE, FOOTNOTE_REF_RE, MATH_RE, SUPERSCRIPT_RE, STRIKETHROUGH_OR_SUBSCRIPT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      if (re === STRIKETHROUGH_OR_SUBSCRIPT_RE && m[1] === undefined) continue; // a real ~~strikethrough~~ match — already flagged by the `del`-token branch
      const label =
        re === WIKILINK_RE ? "Wikilink" : re === FOOTNOTE_REF_RE ? "Footnote reference" : re === MATH_RE ? "Math" : re === SUPERSCRIPT_RE ? "Superscript" : "Subscript";
      const category: CompatCategory = re === WIKILINK_RE ? "app-only" : "flavor-specific";
      issues.push({ category, label, from: start + m.index, to: start + m.index + m[0].length });
    }
  }
}
```

In the main block-token loop, add a definition-list check alongside the existing `table`/`list` block-level checks (this can sit right before the final `if ("tokens" in token)` fallback, since a definition list is otherwise just an ordinary `paragraph` token):

```ts
if (token.type === "paragraph") {
  DEFLIST_GROUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFLIST_GROUP_RE.exec(token.raw))) {
    issues.push({ category: "flavor-specific", label: "Definition list", from: start + m.index, to: start + m.index + m[0].length });
  }
  walkInline((token as { tokens?: Token[] }).tokens, token.raw, start);
  continue;
}
```

(This replaces falling through to the generic `if ("tokens" in token)` branch for `paragraph` tokens specifically — every other block type with a `.tokens` array is unaffected.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/markdown-compat.test.ts`
Expected: PASS (all tests, including the full pre-existing suite — no regressions)

- [ ] **Step 5: Typecheck, format, and commit**

```bash
npm run typecheck
npm run format
git add client/src/markdown-compat.ts tests/client/src/markdown-compat.test.ts
git commit -m "feat: flag definition lists, superscript, and subscript in the compatibility checker"
```

---

### Task 4: `mmd-metadata.ts` — parse and serialize

**Files:**
- Create: `client/src/mmd-metadata.ts`
- Test: `tests/client/src/mmd-metadata.test.ts`

**Interfaces:**
- Produces: `MetadataPair` (`{ key: string; value: string }`), `parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string }`, `serializeMetadataBlock(metadata: MetadataPair[], body: string): string` — `MetadataPair`/`parseMetadataBlock` consumed by Task 5, `serializeMetadataBlock` consumed by Tasks 6 and 9.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/client/src/mmd-metadata.test.ts
import { describe, it, expect } from "vitest";
import { parseMetadataBlock, serializeMetadataBlock } from "../../../client/src/mmd-metadata";

describe("parseMetadataBlock", () => {
  it("parses a simple block", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Doc\nAuthor: Jane\n\n# Heading\n");
    expect(metadata).toEqual([
      { key: "Title", value: "My Doc" },
      { key: "Author", value: "Jane" },
    ]);
    expect(body).toBe("# Heading\n");
  });

  it("joins an indented continuation line into the previous value", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Very\n  Long Title\n\nBody text.\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Very Long Title" }]);
    expect(body).toBe("Body text.\n");
  });

  it("returns the body unchanged when there is no metadata block", () => {
    const input = "Just a heading\n\nSome text.\n";
    const { metadata, body } = parseMetadataBlock(input);
    expect(metadata).toEqual([]);
    expect(body).toBe(input);
  });

  it("stops at the first non-matching, non-blank line even with no blank-line separator", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Doc\nThis is a heading\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Doc" }]);
    expect(body).toBe("This is a heading\n");
  });
});

describe("serializeMetadataBlock", () => {
  it("returns body unchanged when metadata is empty", () => {
    expect(serializeMetadataBlock([], "Body text.\n")).toBe("Body text.\n");
  });

  it("round-trips a single-line-only document exactly", () => {
    const original = "Title: My Doc\nAuthor: Jane\n\nBody text.\n";
    const { metadata, body } = parseMetadataBlock(original);
    expect(serializeMetadataBlock(metadata, body)).toBe(original);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/mmd-metadata.test.ts`
Expected: FAIL — `Cannot find module '../../../client/src/mmd-metadata'`

- [ ] **Step 3: Implement `mmd-metadata.ts`**

```ts
// client/src/mmd-metadata.ts
export interface MetadataPair {
  key: string;
  value: string;
}

const METADATA_LINE_RE = /^([A-Za-z][\w \t-]*):[ \t]+(.*)$/;
const CONTINUATION_LINE_RE = /^[ \t]+(.*)$/;

// Metadata must be the first thing in the document: a run of "Key: Value" lines
// (any key name — this app doesn't restrict to a known set), each optionally
// followed by indented continuation lines that extend the previous value
// (joined with a space), terminated by the first blank line (consumed as the
// separator) or the first non-matching, non-blank line (left in body). If line
// 1 doesn't match, there is no metadata block at all.
export function parseMetadataBlock(text: string): { metadata: MetadataPair[]; body: string } {
  const lines = text.split("\n");
  const metadata: MetadataPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      break;
    }
    const m = METADATA_LINE_RE.exec(line);
    if (!m) break;
    let value = m[2]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== "" && CONTINUATION_LINE_RE.test(lines[j]!)) {
      value += ` ${lines[j]!.trim()}`;
      j++;
    }
    metadata.push({ key: m[1]!.trim(), value });
    i = j;
  }
  if (metadata.length === 0) return { metadata: [], body: text };
  return { metadata, body: lines.slice(i).join("\n") };
}

// Inverse of parseMetadataBlock — a real "Key: Value\n" block, one line per
// pair (continuation lines are never re-derived; a value is written back out
// as a single line even if it was originally read from a continuation),
// followed by a blank line, prepended to body. Returns body unchanged if
// metadata is empty.
export function serializeMetadataBlock(metadata: MetadataPair[], body: string): string {
  if (metadata.length === 0) return body;
  const block = metadata.map((m) => `${m.key}: ${m.value}`).join("\n");
  return `${block}\n\n${body}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/mmd-metadata.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/mmd-metadata.ts tests/client/src/mmd-metadata.test.ts
git commit -m "feat: add MultiMarkdown metadata block parse/serialize"
```

---

### Task 5: `Doc.metadata` field and `stores/docs.ts` wiring

**Files:**
- Modify: `client/src/types.ts` (`Doc` interface only — `MDEBridge` is Task 6)
- Modify: `client/src/stores/docs.ts`
- Test: `tests/client/src/stores/docs.test.ts`

**Interfaces:**
- Consumes: `MetadataPair`, `parseMetadataBlock` from Task 4.
- Produces: `Doc.metadata?: MetadataPair[]`, `setActiveDocMetadata(metadata: MetadataPair[]): void`, `syncRemoteDocContent(id, content, images, name?, metadata?): boolean` (new optional 5th param) — consumed by Tasks 6, 7, 8.

- [ ] **Step 1: Add the `Doc.metadata` field**

At the top of `client/src/types.ts`, add:

```ts
import type { MetadataPair } from "./mmd-metadata";
```

At the end of the `Doc` interface (after the existing `notes?: Note[];` field):

```ts
  // MultiMarkdown-style document metadata (Title/Author/etc.) — freeform
  // Key: Value pairs, edited via Document Info, not present in the live editor
  // body (see mmd-metadata.ts). Order preserved for round-tripping on export.
  metadata?: MetadataPair[];
```

This is a new optional field on an existing interface — nothing else implements or requires it, so `npm run typecheck` stays clean through this step (unlike the `MDEBridge` additions in Task 6, which land together with their implementation in the same task specifically to avoid an interim break).

- [ ] **Step 2: Write the failing tests**

Add to `tests/client/src/stores/docs.test.ts`, inside the existing `describe("docs store — workspace integration", ...)` block — this file resets modules per test (`vi.resetModules()` in `beforeEach`) so every test imports fresh via `await import(...)`, never a static top-level import; follow that exact pattern, matching e.g. the existing `syncRemoteDocContent` tests around line 463 onward:

```ts
it("createDoc splits a leading metadata block out of imported content", async () => {
  const { createDoc } = await import("../../../../client/src/stores/docs");
  const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
  const ws = createWorkspace("Notes");
  const doc = createDoc({ workspaceId: ws.id, content: "Title: Imported Doc\nAuthor: Jane\n\n# Real content\n" });
  expect(doc.metadata).toEqual([
    { key: "Title", value: "Imported Doc" },
    { key: "Author", value: "Jane" },
  ]);
  expect(doc.content).toBe("# Real content\n");
});

it("createDoc never re-parses content when metadata is already provided (duplicate case)", async () => {
  const { createDoc } = await import("../../../../client/src/stores/docs");
  const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
  const ws = createWorkspace("Notes");
  const doc = createDoc({ workspaceId: ws.id, content: "Title: Not Metadata\n\nJust content.", metadata: [{ key: "Custom", value: "value" }] });
  expect(doc.metadata).toEqual([{ key: "Custom", value: "value" }]);
  expect(doc.content).toBe("Title: Not Metadata\n\nJust content.");
});

it("setActiveDocMetadata updates and persists the active doc's metadata", async () => {
  const { createDoc, setActiveDocMetadata, findDocById } = await import("../../../../client/src/stores/docs");
  const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
  const ws = createWorkspace("Notes");
  // createDoc() itself calls the module-private setActiveId(doc.id), so the
  // just-created doc is already the active doc — no separate "select it"
  // step needed, same as every other active-doc setter (setDocImage,
  // addDocNote) already assumes elsewhere in this codebase.
  const doc = createDoc({ workspaceId: ws.id, name: "Test" });
  setActiveDocMetadata([{ key: "Title", value: "Set via UI" }]);
  expect(findDocById(doc.id)?.metadata).toEqual([{ key: "Title", value: "Set via UI" }]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: FAIL — `doc.metadata` is `undefined` in the first two; `setActiveDocMetadata is not a function` in the third.

- [ ] **Step 4: Implement**

Add the import near the top of `client/src/stores/docs.ts`:

```ts
import { parseMetadataBlock, type MetadataPair } from "../mmd-metadata";
```

In `createDoc()`, right before the existing `const doc: Doc = Object.assign(...)` line, add the import-parsing branch and adjust the assembled doc:

```ts
export function createDoc(partial?: Partial<Doc> & { id?: string; name?: string }): Doc {
  saveActiveDocContent();
  let workspaceId = get(activeWorkspaceIdStore) ?? get(workspacesStore)[0]?.id;
  if (!workspaceId) workspaceId = createWorkspace("My Workspace").id;
  let resolvedPartial = partial;
  if (partial?.content && !partial.metadata) {
    const { metadata, body } = parseMetadataBlock(partial.content);
    if (metadata.length > 0) resolvedPartial = { ...partial, content: body, metadata };
  }
  const doc: Doc = Object.assign({ id: uid(), name: "Untitled", content: "", updatedAt: Date.now(), createdAt: Date.now(), workspaceId }, resolvedPartial);
  doc.name = ensureUniqueName(doc.name, get(docsStore));
  docsStore.update((docs) => [doc, ...docs]);
  setActiveId(doc.id);
  persistDocs();
  return doc;
}
```

Add the new setter right after `renameDoc`:

```ts
export function setActiveDocMetadata(metadata: MetadataPair[]) {
  const doc = getActiveDoc();
  if (!doc) return;
  updateDoc(doc.id, { metadata });
  persistDocs();
}
```

Extend `syncRemoteDocContent`'s signature and body:

```ts
export function syncRemoteDocContent(id: string, content: string, images: Record<string, string> | undefined, name?: string, metadata?: MetadataPair[]): boolean {
  const doc = findDocById(id);
  if (!doc) return false;
  const contentChanged = content !== doc.content;
  const imagesChanged = !sameImages(images, doc.images);
  const finalName = name !== undefined ? ensureUniqueName(name || "Untitled", get(docsStore), id) : undefined;
  const nameChanged = finalName !== undefined && finalName !== doc.name;
  const metadataChanged = metadata !== undefined && JSON.stringify(metadata) !== JSON.stringify(doc.metadata ?? []);
  if (!contentChanged && !imagesChanged && !nameChanged && !metadataChanged) return false;
  updateDoc(id, { content, images, ...(nameChanged ? { name: finalName } : {}), ...(metadataChanged ? { metadata } : {}), updatedAt: Date.now() });
  return true;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add client/src/types.ts client/src/stores/docs.ts tests/client/src/stores/docs.test.ts
git commit -m "feat: add Doc.metadata field, parse metadata on doc import, add setActiveDocMetadata"
```

---

### Task 6: `MDEBridge` metadata hooks, `app.ts` wiring, and export integration

**Files:**
- Modify: `client/src/types.ts` (`MDEBridge` interface)
- Modify: `client/src/app.ts`

**Interfaces:**
- Consumes: `setActiveDocMetadata` (Task 5), `serializeMetadataBlock` (Task 4).
- Produces: `MDEBridge.setDocMetadata(id: string, metadata: MetadataPair[]): void` and `MDEBridge.onDocMetadataChanged: ((id: string, metadata: MetadataPair[]) => void) | null`, both declared *and* implemented in this single task (see the Global Constraints note on why) — consumed by Tasks 7 and 8.

- [ ] **Step 1: Add the `MDEBridge` hooks**

In `client/src/types.ts`, find the `MDEBridge` interface's existing `setDocName`/`onDocRenamed` pair and add the parallel metadata pair immediately after `onDocRenamed`:

```ts
  setDocMetadata(id: string, metadata: MetadataPair[]): void;
  onDocMetadataChanged: ((id: string, metadata: MetadataPair[]) => void) | null;
```

- [ ] **Step 2: Add the bridge method and null hook in `app.ts`**

Add the `setActiveDocMetadata` import from `./stores/docs` alongside this file's existing `getActiveDoc`/`renameDoc` imports from that module.

In `app.ts`'s `bridge: MDEBridge` object literal, add `setDocMetadata` right after the existing `setDocName` method, and `onDocMetadataChanged: null` right after `onDocRenamed: null`:

```ts
    setDocMetadata(id, metadata) {
      if (getActiveDoc()?.id !== id) return;
      setActiveDocMetadata(metadata);
    },
    onDocMetadataChanged: null,
```

- [ ] **Step 3: Wire metadata into `getResolvedContent()` and `exportAs("md")`**

Add the import: `import { serializeMetadataBlock } from "./mmd-metadata";`

Change `getResolvedContent()`:

```ts
    getResolvedContent() {
      const doc = getActiveDoc();
      const resolved = resolveDiagramRefs(resolveImageRefs(cm.state.doc.toString(), doc), doc?.diagrams);
      return serializeMetadataBlock(doc?.metadata ?? [], resolved);
    },
```

Change `exportAs("md")`'s branch:

```ts
    if (format === "md") {
      const doc = getActiveDoc();
      const resolved = resolveDiagramRefs(resolveImageRefs(raw, doc), doc?.diagrams);
      const withMetadata = serializeMetadataBlock(doc?.metadata ?? [], resolved);
      downloadBlob(new Blob([withMetadata], { type: "text/markdown;charset=utf-8" }), `${base}.md`);
      showToast(`Exported ${base}.md`, "success");
      return;
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors — the interface and its implementation land together in this task, so there's no interim broken window.

- [ ] **Step 5: Manual verification**

Start the app (`npm run dev:client`), open Document Info, add a metadata field (e.g. `Title` / `Test Doc`), then File → Export → Markdown (.md). Open the downloaded file and confirm it starts with `Title: Test Doc` followed by a blank line, then the document body.

- [ ] **Step 6: Commit**

```bash
git add client/src/types.ts client/src/app.ts
git commit -m "feat: wire document metadata into the bridge, Gist publish, and .md export"
```

---

### Task 7: `DocInfoPanel.svelte` — Metadata UI section

**Files:**
- Modify: `client/src/components/DocInfoPanel.svelte`
- Modify: `client/src/styles/_modals.scss`
- Test: `tests/client/src/components/DocInfoPanel.test.ts` (new)

**Interfaces:**
- Consumes: `setActiveDocMetadata`, `Doc.metadata` (Task 5). Calls `window.MDE.onDocMetadataChanged?.(doc.id, metadata)` (Task 6's bridge hook, fully implemented by the time this task runs).

- [ ] **Step 1: Write the failing component test**

```ts
// tests/client/src/components/DocInfoPanel.test.ts
//
// render() from "vitest-browser-svelte" is async and *returns* the query
// object (there is no separate "screen" export) — matches this repo's own
// existing components-project tests, e.g. Toggletip.test.ts/
// GistVisibilityDialog.test.ts: `const screen = await render(Component)`,
// then `screen.getByRole(...)`, asserted with `expect.element(...)`.
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import DocInfoPanel from "../../../../client/src/components/DocInfoPanel.svelte";
import { docInfoPanelOpen } from "../../../../client/src/stores/docInfoPanel";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  // DocInfoPanel's template calls window.MDE.formatRelativeTime(...)
  // directly (not optional-chained) for the Created/Edited rows, so it
  // must be stubbed or rendering throws — the rest of window.MDE isn't
  // touched by anything these tests exercise.
  window.MDE = { formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", metadata: [{ key: "Title", value: "Existing" }] }]);
  activeIdStore.set("d1");
  docInfoPanelOpen.set(true);
});

test("renders existing metadata pairs as rows", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByDisplayValue("Title")).toBeVisible();
  await expect.element(screen.getByDisplayValue("Existing")).toBeVisible();
});

test("Add field appends an empty row", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByPlaceholder("Key")).toHaveCount?.(1); // adjust if getByPlaceholder doesn't support toHaveCount directly — the intent is "exactly one Key input before clicking"
  await screen.getByRole("button", { name: "Add field" }).click();
  const keyInputs = screen.getByPlaceholder("Key").all();
  expect((await keyInputs).length).toBe(2);
});

test("deleting a row removes it", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Remove field" }).click();
  await expect.element(screen.getByDisplayValue("Title")).not.toBeInTheDocument();
});
```

(The exact locator API for "count how many Key inputs exist" — `.all()`, `.elements()`, or similar — depends on this repo's exact `vitest-browser-svelte`/Playwright-provider version; check one of the existing component tests for the established way to assert on a *list* of matching elements, since none of `Toggletip.test.ts`/`GistVisibilityDialog.test.ts` need that pattern themselves.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts`
Expected: FAIL — no metadata section exists yet in the rendered output.

- [ ] **Step 3: Implement the UI**

In `client/src/components/DocInfoPanel.svelte`, add the import and state near the existing `compatIssues`/`compatExpanded` declarations:

```ts
import { setActiveDocMetadata } from "../stores/docs";
import type { MetadataPair } from "../mmd-metadata";
```

```ts
function updateMetadata(next: MetadataPair[]) {
  if (!doc) return;
  setActiveDocMetadata(next);
  window.MDE.onDocMetadataChanged?.(doc.id, next);
}

function addMetadataField() {
  updateMetadata([...(doc?.metadata ?? []), { key: "", value: "" }]);
}

function updateMetadataField(index: number, field: "key" | "value", value: string) {
  const next = (doc?.metadata ?? []).map((pair, i) => (i === index ? { ...pair, [field]: value } : pair));
  updateMetadata(next);
}

function removeMetadataField(index: number) {
  updateMetadata((doc?.metadata ?? []).filter((_, i) => i !== index));
}
```

Add the template section after the existing Compatibility `{#if compatExpanded ...}` block, before `{#if doc.repoPath || doc.gistId}`:

```svelte
<div class="menu-section-label">Metadata</div>
<div class="doc-info-metadata-list">
  {#each doc.metadata ?? [] as pair, i}
    <div class="doc-info-metadata-row">
      <input type="text" placeholder="Key" value={pair.key} oninput={(e) => updateMetadataField(i, "key", (e.target as HTMLInputElement).value)} />
      <input type="text" placeholder="Value" value={pair.value} oninput={(e) => updateMetadataField(i, "value", (e.target as HTMLInputElement).value)} />
      <button type="button" class="doc-info-metadata-remove" aria-label="Remove field" onclick={() => removeMetadataField(i)}>
        <svg class="icon"><use href="#icon-trash-2"></use></svg>
      </button>
    </div>
  {/each}
  <button type="button" class="secondary-btn" onclick={addMetadataField}>Add field</button>
</div>
```

Add to `client/src/styles/_modals.scss`, next to the panel's other `doc-info-*` rules:

```scss
.doc-info-metadata-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.doc-info-metadata-row {
  display: flex;
  gap: 6px;
  align-items: center;

  input {
    flex: 1;
    min-width: 0;
  }
}
.doc-info-metadata-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);

  &:hover {
    color: var(--danger, #d33);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts`
Expected: PASS — adjust the test's exact selectors/assertions to match whatever markup actually rendered, per the note in Step 1, then confirm green.

- [ ] **Step 5: Typecheck, format, and commit**

```bash
npm run typecheck
npm run format
git add client/src/components/DocInfoPanel.svelte client/src/styles/_modals.scss tests/client/src/components/DocInfoPanel.test.ts
git commit -m "feat: add a Metadata section to the Document Info panel"
```

---

### Task 8: `collab.ts` — sync `metadata` on the Y.Doc `meta` map

**Files:**
- Modify: `client/src/collab.ts`
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `syncRemoteDocContent` (Task 5, new `metadata` param), `MDEBridge.setDocMetadata`/`onDocMetadataChanged` (Task 6).

- [ ] **Step 1: Write the failing tests**

`collab.test.ts`'s own top-of-file comment establishes that `init()` never actually runs in this jsdom test file (`DOMContentLoaded` has already fired before the module loads) — so `window.MDE.onDocMetadataChanged`'s *assignment* (which happens inside `init()`, mirroring `onDocRenamed`) has no dedicated unit test here, same as `onDocRenamed`'s own assignment doesn't either; it's only exercised for real by the `test:e2e:collab` suite (see Task 12). What *is* testable here, because it doesn't depend on `init()` running, is `seedDocBindingFromEditor` (called directly from `setAccessMode`'s connect flow) and `metaMap.observe(...)` (registered inside `createDocBinding`). Add these two tests inside the existing `describe("shared document name sync", ...)` block in `tests/client/src/collab.test.ts`, right after the two existing tests shown below for context:

```ts
// Existing, for context — do not duplicate:
//   it("seeds the shared doc's current name into its Y.Doc meta map when sharing for the first time", async () => {
//     await setAccessMode("anyone-link", "editor");
//     for (let i = 0; i < 10; i++) await Promise.resolve();
//     const binding = workspaceRoom.docs.get("doc1");
//     expect(binding?.metaMap.get("name")).toBe("My Doc");
//   });
//   it("applies a remote rename on the active doc via MDE.setDocName", async () => {
//     await setAccessMode("anyone-link", "editor");
//     for (let i = 0; i < 10; i++) await Promise.resolve();
//     const binding = workspaceRoom.docs.get("doc1")!;
//     binding.ydoc.transact(() => binding.metaMap.set("name", "Renamed By Collaborator"), "server");
//     expect(window.MDE.setDocName).toHaveBeenCalledWith("doc1", "Renamed By Collaborator");
//   });

it("seeds the shared doc's current metadata into its Y.Doc meta map when sharing for the first time", async () => {
  docsStore.set([{ id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1", metadata: [{ key: "Title", value: "My Doc" }] }]);
  await setAccessMode("anyone-link", "editor");
  for (let i = 0; i < 10; i++) await Promise.resolve();

  const binding = workspaceRoom.docs.get("doc1");
  expect(JSON.parse(binding?.metaMap.get("metadata") ?? "[]")).toEqual([{ key: "Title", value: "My Doc" }]);
});

it("applies a remote metadata change on the active doc via MDE.setDocMetadata", async () => {
  await setAccessMode("anyone-link", "editor");
  for (let i = 0; i < 10; i++) await Promise.resolve();

  const binding = workspaceRoom.docs.get("doc1")!;
  binding.ydoc.transact(() => binding.metaMap.set("metadata", JSON.stringify([{ key: "Title", value: "Remote" }])), "server");

  expect(window.MDE.setDocMetadata).toHaveBeenCalledWith("doc1", [{ key: "Title", value: "Remote" }]);
});
```

This also means `beforeEach`'s `window.MDE` mock object needs a `setDocMetadata: vi.fn()` entry added alongside its existing `setDocName: vi.fn()` (both in the `describe("shared document name sync", ...)` block's `beforeEach`), or the second new test above will throw calling an undefined function.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: FAIL — `metaMap.get("metadata")` is `undefined`; `setDocMetadata` never called.

- [ ] **Step 3: Implement**

In `seedDocBindingFromEditor`, extend the existing `metaMap.set("name", ...)` transaction:

```ts
  if (doc && doc.id === docId) {
    binding.ydoc.transact(() => {
      binding.metaMap.set("name", doc.name || "Untitled");
      binding.metaMap.set("metadata", JSON.stringify(doc.metadata ?? []));
      if (doc.images) Object.entries(doc.images).forEach(([key, dataUrl]) => binding.imagesMap.set(key, dataUrl));
    }, "local");
  }
```

In `createDocBinding`'s `metaMap.observe(...)`, extend the existing name-only branch to also handle `"metadata"`:

```ts
  const metaMap = ydoc.getMap<string>("meta");
  metaMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    if (event.changes.keys.has("name")) {
      if (workspaceRoom.activeDocId === docId) {
        const name = metaMap.get("name");
        if (name !== undefined) window.MDE.setDocName(docId, name);
      } else {
        markDirty(docId);
      }
    }
    if (event.changes.keys.has("metadata")) {
      if (workspaceRoom.activeDocId === docId) {
        const raw = metaMap.get("metadata");
        if (raw !== undefined) window.MDE.setDocMetadata(docId, JSON.parse(raw));
      } else {
        markDirty(docId);
      }
    }
  });
```

In `flushDirtyBackgroundDocs`, extend the read and the `syncRemoteDocContent` call:

```ts
    const name = binding.metaMap.get("name");
    const metadataRaw = binding.metaMap.get("metadata");
    const metadata = metadataRaw !== undefined ? JSON.parse(metadataRaw) : undefined;
    if (syncRemoteDocContent(docId, content, images, name, metadata)) changed = true;
```

In `init()`, add the outbound hook alongside `collab.ts`'s own existing `init()` assignments (e.g. right after the existing `window.MDE.onImageAdded = ...` assignment):

```ts
  window.MDE.onDocMetadataChanged = (docId, metadata) => {
    const binding = workspaceRoom.docs.get(docId);
    if (binding) binding.ydoc.transact(() => binding.metaMap.set("metadata", JSON.stringify(metadata)), "local");
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: sync document metadata over the workspace room's meta map"
```

---

### Task 9: `repo-sync.ts` — serialize metadata into the pushed content

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `tests/client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `serializeMetadataBlock` (Task 4).

- [ ] **Step 1: Write the failing test**

Add to `tests/client/src/repo-sync.test.ts`, near any existing test that exercises the push loop calling `rewriteImagesForPush` (or, if the push loop itself isn't directly tested there today, add a focused test against the surrounding push function with a doc that has `metadata` set):

```ts
it("prepends the document's metadata block to pushed content", () => {
  const doc = { id: "d1", name: "Test", content: "# Body\n", updatedAt: 0, createdAt: 0, workspaceId: "w1", metadata: [{ key: "Title", value: "Pushed Doc" }] };
  // ...call whatever this file's push-loop entry point is with `doc`...
  // assert the resulting pushed content starts with "Title: Pushed Doc\n\n# Body\n"
});
```

(Adapt to this file's actual exported push-loop function name/signature — read `repo-sync.ts`'s existing exports and this test file's existing setup for the surrounding push flow before writing the exact call.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/client/src/repo-sync.test.ts`
Expected: FAIL — pushed content has no metadata block prepended.

- [ ] **Step 3: Implement**

Add the import: `import { serializeMetadataBlock } from "./mmd-metadata";`

Change the push-loop call site:

```ts
const { content, assets } = rewriteImagesForPush(serializeMetadataBlock(doc.metadata ?? [], doc.content), slugFromRepoPath(repoPath), doc.images, doc.diagrams);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/client/src/repo-sync.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/repo-sync.ts tests/client/src/repo-sync.test.ts
git commit -m "feat: include document metadata when pushing to a linked repo"
```

---

### Task 10: e2e coverage for the metadata UI round-trip

**Files:**
- Modify: `tests/e2e/local/mmd-syntax.spec.ts` (created in Task 2)

**Interfaces:**
- Consumes: the fully-wired feature from Tasks 4–7.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/local/mmd-syntax.spec.ts`:

```ts
test("adding a metadata field in Document Info round-trips through .md export", async ({ page }) => {
  await page.click("#docInfoBtn"); // adjust to this app's actual Document Info trigger id/selector
  await page.click('button:has-text("Add field")');
  await page.fill('.doc-info-metadata-row input[placeholder="Key"]', "Title");
  await page.fill('.doc-info-metadata-row input[placeholder="Value"]', "Round Trip Test");

  const downloadPromise = page.waitForEvent("download");
  await page.click("#menuFile"); // adjust to this app's actual File-menu / export-as-md trigger
  await page.click("text=Markdown (.md)");
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("fs");
  const content = fs.readFileSync(path!, "utf-8");
  expect(content.startsWith("Title: Round Trip Test\n\n")).toBe(true);
});
```

(Adjust the Document Info panel's open-trigger selector and the File-menu export selector to match this app's actual existing selectors — check `tests/e2e/local/export.spec.ts` for the established `.md` export trigger pattern and mirror it exactly.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --project=local -g "round-trips through .md export"`
Expected: FAIL — either the Document Info trigger/export trigger selectors need adjusting first (per the note above), or, once those are correct, the exported file doesn't yet start with the metadata block if any earlier task was skipped.

- [ ] **Step 3: Fix selectors / confirm implementation, run again**

Run: `npx playwright test --project=local -g "round-trips through .md export"`
Expected: PASS

- [ ] **Step 4: Run the full local Playwright suite**

Run: `npx playwright test --project=local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/local/mmd-syntax.spec.ts
git commit -m "test: cover the document-metadata UI-to-export round trip end to end"
```

---

### Task 11: Version bump, CHANGELOG, What's New, IMPROVEMENTS.md

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `IMPROVEMENTS.md`
- Create: `client/public/whats-new/multimarkdown-syntax-support.png`

**Interfaces:**
- Consumes: nothing new — this is documentation/metadata for the already-complete feature.

- [ ] **Step 1: Bump the version**

Read `package.json`'s current `"version"`, bump the minor component (this is a user-facing feature, per this repo's CLAUDE.md versioning convention), and hand-edit both `package.json`'s `"version"` and `package-lock.json`'s two `"version"` fields (top-level and the `packages[""].version` entry) to match — do not run `npm install --package-lock-only`.

- [ ] **Step 2: Add the CHANGELOG entry**

Add a new `## [1.X.0] - 2026-08-28` section at the top of `CHANGELOG.md` (Keep a Changelog format):

```markdown
## [1.X.0] - 2026-08-28

### Added

- **MultiMarkdown syntax support: definition lists, superscript/subscript, and document metadata.** `Term` / `:   Definition` now renders as a real definition list; `2^10^` and `H~2~O` render as superscript/subscript. A new Metadata section in Document Info lets you add freeform `Key: Value` fields to a document — they round-trip as a real MultiMarkdown metadata block on `.md` export, Gist publish, and repo push, and are parsed back out automatically when opening a file that already has one. The Markdown Compatibility Checker now flags definition lists, superscript, and subscript as flavor-specific.
```

- [ ] **Step 3: Take a real screenshot for What's New**

Start the app locally, type a short document exercising the new syntax (a definition list, a superscript, and at least one metadata field visible in an open Document Info panel), and capture a screenshot to `client/public/whats-new/multimarkdown-syntax-support.png` (match the framing/size of an existing file in that directory, e.g. `markdown-compatibility-checker.png`).

- [ ] **Step 4: Add the What's New entry**

Append to the end of `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts` (oldest-first, so this goes last):

```ts
  {
    version: "1.X.0",
    title: "MultiMarkdown Syntax Support",
    description:
      "Definition lists and superscript/subscript now render correctly, and a new Metadata section in Document Info lets you add Title/Author/etc. fields that round-trip as real MultiMarkdown text on export, Gist publish, and repo push.",
    screenshot: "/whats-new/multimarkdown-syntax-support.png",
  },
```

(Replace `1.X.0` everywhere above with the actual version chosen in Step 1.)

- [ ] **Step 5: Update IMPROVEMENTS.md**

Change the Phase 2 line:

```markdown
- [ ] MultiMarkdown syntax support.
```

to:

```markdown
- [x] MultiMarkdown syntax support. (Shipped v1.X.0 as definition lists,
      superscript/subscript, and a structured document-metadata field —
      round-trips as a real Key: Value block on import/export. Citations
      & bibliography split off as its own separate, still-open item below.)
- [ ] **Citations & bibliography.** `[#Author2000]`-style citations resolved
      against a bibliography — needs its own bibliography data model and UI,
      split off from the MultiMarkdown syntax support item above as too
      different in kind to bundle with it.
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/multimarkdown-syntax-support.png IMPROVEMENTS.md
git commit -m "docs: version/changelog/what's-new for MultiMarkdown syntax support"
```

---

### Task 12: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit/component test suite**

Run: `npm test`
Expected: PASS (all `unit` and `components` project tests)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: PASS — if not, run `npm run format` and re-commit

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no errors

- [ ] **Step 5: Full local Playwright e2e suite**

Run: `npm run test:e2e:local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Collab e2e suite**

Run: `npm run test:e2e:collab`
Expected: PASS — this specifically exercises the `metaMap` sync path Task 8 touched; watch closely for anything related to document rename/metadata sync.

- [ ] **Step 7: Manual smoke test**

Using `npm run dev` (after `npm run build`), manually verify: typing a definition list and superscript/subscript renders correctly; adding/editing/removing a metadata field in Document Info works and persists across a reload; sharing a workspace and editing metadata from a second browser tab syncs live to the first.

- [ ] **Step 8: Hand off to finishing-a-development-branch**

Once all of the above are green, proceed to `superpowers:finishing-a-development-branch` to decide how to integrate this branch.
