# Citations & Bibliography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable citation support — `[@key]`/`[#key]` markers resolved against a bibliography, with three independent per-document settings (marker syntax, bibliography source, display style) editable from Document Info.

**Architecture:** One new pure preprocessing module (`mmd-citations.ts`), wired into the existing `Preview.svelte` render pipeline, following the exact same Doc-field/UI/collab-sync/export-import playbook the Metadata feature already established (`Doc.citations`, `setActiveDocCitations`, a `"citations"` key on the Y.Doc `meta` map, structured-mode round-tripping on export).

**Tech Stack:** TypeScript, Svelte 5, `marked` (`marked.parseInline()`), Yjs (`Y.Map` sync), Vitest (`unit` + `components` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-29-citations-and-bibliography-design.md`

## Global Constraints

- Three independent per-document settings: marker syntax (`pandoc` `[@key]` / `multimarkdown` `[#key]`), bibliography source (`text` typed definitions / `structured` UI-edited entries), display style (`numbered` footnote-style / `author-year` inline `(Smith, 2020)`).
- `author-year` requires `bibliographySource: "structured"` — the UI disables (not hides) that option when source is `text`, and switching source away from `structured` while `author-year` is active falls back to `numbered`.
- No changes to `createDoc()` — `text`-source mode needs no import-time action (see spec's Non-goals).
- `citations` is one field (`{ prefs: CitationPrefs; bibliography: BibEntry[] }`), not two, since both parts sync together as a single unit.
- This is a user-facing feature: minor version bump, `CHANGELOG.md` entry, and a `whats-new-entries.ts` entry with a real screenshot.
- Per the Metadata feature's own lesson: `MDEBridge` interface members and their `app.ts` implementation land together in one task, never split across a task boundary, so `npm run typecheck` never has an interim broken window.
- **Task order in this file is execution order.** `Doc.citations` (Task 2) is deliberately placed before the `Preview.svelte` wiring (Task 3) that reads it, so `npm run typecheck` never has an interim broken window between tasks.

---

### Task 1: `mmd-citations.ts` — core transform

**Files:**
- Create: `client/src/mmd-citations.ts`
- Test: `tests/client/src/mmd-citations.test.ts`

**Interfaces:**
- Produces: `BibEntry`, `CitationPrefs`, `DEFAULT_CITATION_PREFS`, `EMPTY_CITATIONS`, `PANDOC_CITATION_RE`, `MULTIMARKDOWN_CITATION_RE`, `transformCitations(text: string, prefs: CitationPrefs, structuredBibliography: BibEntry[]): string` — consumed by Task 2 (`Doc.citations` field), Task 3 (`Preview.svelte`), Task 4 (`markdown-compat.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/client/src/mmd-citations.test.ts
import { describe, it, expect } from "vitest";
import { transformCitations, DEFAULT_CITATION_PREFS, type CitationPrefs, type BibEntry } from "../../../client/src/mmd-citations";

function prefs(overrides: Partial<CitationPrefs> = {}): CitationPrefs {
  return { ...DEFAULT_CITATION_PREFS, ...overrides };
}

describe("transformCitations — text source", () => {
  it("renders a numbered citation and strips the definition line, appending a Bibliography section", () => {
    const out = transformCitations("A claim.[@Smith2020]\n\n[@Smith2020]: Smith, J. (2020). Title. Publisher.\n", prefs(), []);
    expect(out).toContain('<sup><a href="#cite-Smith2020">1</a></sup>');
    expect(out).not.toContain("[@Smith2020]: Smith");
    expect(out).toContain('<div class="citation-bibliography">');
    expect(out).toContain('<li id="cite-Smith2020">Smith, J. (2020). Title. Publisher.</li>');
  });

  it("supports the multimarkdown marker style", () => {
    const out = transformCitations("A claim.[#Smith2020]\n\n[#Smith2020]: Smith, J. (2020). Title.\n", prefs({ markerStyle: "multimarkdown" }), []);
    expect(out).toContain('<sup><a href="#cite-Smith2020">1</a></sup>');
  });

  it("leaves an unknown citation key untouched", () => {
    const out = transformCitations("A claim.[@Nobody]\n", prefs(), []);
    expect(out).toBe("A claim.[@Nobody]\n");
  });

  it("reuses the same number for repeated citations of the same key", () => {
    const out = transformCitations("First.[@A] Second.[@A]\n\n[@A]: Ref A.\n", prefs(), []);
    const matches = [...out.matchAll(/#cite-A">(\d+)</g)].map((m) => m[1]);
    expect(matches).toEqual(["1", "1"]);
  });

  it("returns the text unchanged when nothing is cited", () => {
    const input = "Just a paragraph, no citations.\n";
    expect(transformCitations(input, prefs(), [])).toBe(input);
  });
});

describe("transformCitations — structured source", () => {
  const bib: BibEntry[] = [
    { key: "A", author: "Alpha, A.", year: "2019", text: "Alpha, A. (2019). First." },
    { key: "B", author: "Beta, B.", year: "2021", text: "Beta, B. (2021). Second." },
  ];

  it("renders numbered citations from structured entries without needing any typed definition line", () => {
    const out = transformCitations("See [@A] and [@B].\n", prefs({ bibliographySource: "structured" }), bib);
    expect(out).toContain('<sup><a href="#cite-A">1</a></sup>');
    expect(out).toContain('<sup><a href="#cite-B">2</a></sup>');
  });

  it("renders author-year inline citations", () => {
    const out = transformCitations("See [@A].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), bib);
    expect(out).toContain("(Alpha, A., 2019)");
  });

  it("falls back to the key when both author and year are blank", () => {
    const blank: BibEntry[] = [{ key: "X", author: "", year: "", text: "Some reference." }];
    const out = transformCitations("See [@X].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), blank);
    expect(out).toContain("(X)");
  });

  it("renders just the available field when only one of author/year is present", () => {
    const partial: BibEntry[] = [{ key: "X", author: "Xavier", year: "", text: "Some reference." }];
    const out = transformCitations("See [@X].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), partial);
    expect(out).toContain("(Xavier)");
  });

  it("sorts the author-year bibliography alphabetically by author, independent of citation order", () => {
    const out = transformCitations("See [@B] then [@A].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), bib);
    expect(out.indexOf('id="cite-A"')).toBeLessThan(out.indexOf('id="cite-B"'));
  });

  it("only includes entries that are actually cited", () => {
    const out = transformCitations("See [@A].\n", prefs({ bibliographySource: "structured" }), bib);
    expect(out).toContain('id="cite-A"');
    expect(out).not.toContain('id="cite-B"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/mmd-citations.test.ts`
Expected: FAIL — `Cannot find module '../../../client/src/mmd-citations'`

- [ ] **Step 3: Implement `mmd-citations.ts`**

```ts
// client/src/mmd-citations.ts
import { marked } from "marked";

export interface BibEntry {
  key: string;
  author: string;
  year: string;
  text: string;
}

export interface CitationPrefs {
  markerStyle: "pandoc" | "multimarkdown";
  bibliographySource: "text" | "structured";
  displayStyle: "numbered" | "author-year";
}

export const DEFAULT_CITATION_PREFS: CitationPrefs = { markerStyle: "pandoc", bibliographySource: "text", displayStyle: "numbered" };
export const EMPTY_CITATIONS = { prefs: DEFAULT_CITATION_PREFS, bibliography: [] as BibEntry[] };

// Exported so markdown-compat.ts can flag both marker styles directly,
// rather than a second, independently-drifting pair of regexes.
export const PANDOC_CITATION_RE = /\[@([^\]\s]+)\]/g;
export const MULTIMARKDOWN_CITATION_RE = /\[#([^\]\s]+)\]/g;

const MARKER_RE: Record<CitationPrefs["markerStyle"], RegExp> = { pandoc: PANDOC_CITATION_RE, multimarkdown: MULTIMARKDOWN_CITATION_RE };
const DEFINITION_RE: Record<CitationPrefs["markerStyle"], RegExp> = {
  pandoc: /^\[@([^\]\s]+)\]:[ \t]+(.+)$/gm,
  multimarkdown: /^\[#([^\]\s]+)\]:[ \t]+(.+)$/gm,
};

export function transformCitations(text: string, prefs: CitationPrefs, structuredBibliography: BibEntry[]): string {
  let body = text;
  const pool = new Map<string, BibEntry>();
  if (prefs.bibliographySource === "structured") {
    for (const entry of structuredBibliography) pool.set(entry.key, entry);
  } else {
    body = body.replace(DEFINITION_RE[prefs.markerStyle], (_match, key: string, refText: string) => {
      pool.set(key, { key, author: "", year: "", text: refText.trim() });
      return "";
    });
  }

  const order: string[] = [];
  body = body.replace(MARKER_RE[prefs.markerStyle], (match, key: string) => {
    const entry = pool.get(key);
    if (!entry) return match;
    if (!order.includes(key)) order.push(key);
    if (prefs.displayStyle === "numbered") {
      const n = order.indexOf(key) + 1;
      return `<sup><a href="#cite-${key}">${n}</a></sup>`;
    }
    const label = entry.author && entry.year ? `${entry.author}, ${entry.year}` : entry.author || entry.year || entry.key;
    return `(${label})`;
  });

  if (order.length === 0) return body;

  const cited = order.map((key) => pool.get(key)!);
  if (prefs.displayStyle === "author-year") cited.sort((a, b) => a.author.localeCompare(b.author));
  const items = cited
    .map((entry) =>
      prefs.displayStyle === "numbered"
        ? `<li id="cite-${entry.key}">${marked.parseInline(entry.text)}</li>`
        : `<li id="cite-${entry.key}">${entry.author} (${entry.year}). ${marked.parseInline(entry.text)}</li>`,
    )
    .join("");
  const listTag = prefs.displayStyle === "numbered" ? "ol" : "ul";
  return `${body}\n\n<div class="citation-bibliography"><h2>Bibliography</h2><${listTag}>${items}</${listTag}></div>\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/mmd-citations.test.ts`
Expected: PASS (all 12 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/mmd-citations.ts tests/client/src/mmd-citations.test.ts
git commit -m "feat: add citation and bibliography transform"
```

---

### Task 2: `Doc.citations` field and `stores/docs.ts` wiring

**Files:**
- Modify: `client/src/types.ts` (`Doc` interface only)
- Modify: `client/src/stores/docs.ts`
- Test: `tests/client/src/stores/docs.test.ts`

**Interfaces:**
- Consumes: `BibEntry`, `CitationPrefs` from Task 1.
- Produces: `Doc.citations?: { prefs: CitationPrefs; bibliography: BibEntry[] }`, `setActiveDocCitations(citations: { prefs: CitationPrefs; bibliography: BibEntry[] }): void`, `syncRemoteDocContent(id, content, images, name?, metadata?, citations?): boolean` (new optional 6th param) — consumed by Tasks 3, 5, 6, 7.

- [ ] **Step 1: Add the `Doc.citations` field**

At the top of `client/src/types.ts`, add to the existing `mmd-metadata`/`mmd-inline-blocks` import area:

```ts
import type { BibEntry, CitationPrefs } from "./mmd-citations";
```

At the end of the `Doc` interface (after the existing `metadata?: MetadataPair[];` field):

```ts
  // Citation/bibliography config and entries — see mmd-citations.ts. One
  // field (not two) since both parts always sync together as a unit.
  citations?: { prefs: CitationPrefs; bibliography: BibEntry[] };
```

- [ ] **Step 2: Write the failing test**

Add to `tests/client/src/stores/docs.test.ts`, inside the existing `describe("docs store — workspace integration", ...)` block, following the same dynamic-`await import(...)` pattern every test in that file uses:

```ts
it("setActiveDocCitations updates and persists the active doc's citations", async () => {
  const { createDoc, setActiveDocCitations, findDocById } = await import("../../../../client/src/stores/docs");
  const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
  const ws = createWorkspace("Notes");
  const doc = createDoc({ workspaceId: ws.id, name: "Test" });
  const citations = { prefs: { markerStyle: "pandoc" as const, bibliographySource: "structured" as const, displayStyle: "numbered" as const }, bibliography: [{ key: "A", author: "Alpha", year: "2020", text: "Alpha (2020)." }] };
  setActiveDocCitations(citations);
  expect(findDocById(doc.id)?.citations).toEqual(citations);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: FAIL — `setActiveDocCitations is not a function`

- [ ] **Step 4: Implement**

Add the import near the top of `client/src/stores/docs.ts`, alongside the existing `mmd-metadata` import:

```ts
import type { BibEntry, CitationPrefs } from "../mmd-citations";
```

Add the new setter right after `setActiveDocMetadata`:

```ts
export function setActiveDocCitations(citations: { prefs: CitationPrefs; bibliography: BibEntry[] }) {
  const doc = getActiveDoc();
  if (!doc) return;
  updateDoc(doc.id, { citations });
  persistDocs();
}
```

Extend `syncRemoteDocContent`'s signature and body (it already has the `metadata` parameter from the MultiMarkdown feature):

```ts
export function syncRemoteDocContent(
  id: string,
  content: string,
  images: Record<string, string> | undefined,
  name?: string,
  metadata?: MetadataPair[],
  citations?: { prefs: CitationPrefs; bibliography: BibEntry[] },
): boolean {
  const doc = findDocById(id);
  if (!doc) return false;
  const contentChanged = content !== doc.content;
  const imagesChanged = !sameImages(images, doc.images);
  const finalName = name !== undefined ? ensureUniqueName(name || "Untitled", get(docsStore), id) : undefined;
  const nameChanged = finalName !== undefined && finalName !== doc.name;
  const metadataChanged = metadata !== undefined && JSON.stringify(metadata) !== JSON.stringify(doc.metadata ?? []);
  const citationsChanged = citations !== undefined && JSON.stringify(citations) !== JSON.stringify(doc.citations ?? {});
  if (!contentChanged && !imagesChanged && !nameChanged && !metadataChanged && !citationsChanged) return false;
  updateDoc(id, {
    content,
    images,
    ...(nameChanged ? { name: finalName } : {}),
    ...(metadataChanged ? { metadata } : {}),
    ...(citationsChanged ? { citations } : {}),
    updatedAt: Date.now(),
  });
  return true;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add client/src/types.ts client/src/stores/docs.ts tests/client/src/stores/docs.test.ts
git commit -m "feat: add Doc.citations field and setActiveDocCitations"
```

---

### Task 3: Wire `mmd-citations.ts` into `Preview.svelte`

**Files:**
- Modify: `client/src/components/Preview.svelte`
- Test: `tests/e2e/local/mmd-citations.spec.ts` (new)

**Interfaces:**
- Consumes: `transformCitations`, `DEFAULT_CITATION_PREFS` from Task 1; `Doc.citations` from Task 2.

- [ ] **Step 1: Write the failing e2e test**

```ts
// tests/e2e/local/mmd-citations.spec.ts
import { test, expect } from "./support/fixtures";

test("a citation with a typed definition renders as a numbered link with a bibliography", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("A claim.[@Smith2020]\n\n[@Smith2020]: Smith, J. (2020). Title. Publisher.");
  await expect(page.locator("#preview .citation-bibliography")).toBeVisible();
  await expect(page.locator("#preview sup a")).toHaveText("1");
  await expect(page.locator("#preview .citation-bibliography li")).toContainText("Smith, J. (2020). Title. Publisher.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --project=local tests/e2e/local/mmd-citations.spec.ts`
Expected: FAIL — no `.citation-bibliography` element (raw text shown instead)

- [ ] **Step 3: Wire the transform into the pipeline**

In `client/src/components/Preview.svelte`, add the import alongside the existing `mmd-inline-blocks` import:

```ts
import { transformCitations, DEFAULT_CITATION_PREFS } from "../mmd-citations";
```

Change the pipeline (right after the `transformDefinitionLists`/`transformSuperscriptSubscript` line added by the MultiMarkdown feature):

```ts
const withInlineBlocks = transformSuperscriptSubscript(transformDefinitionLists(extractedRaw));
const citationPrefs = doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS;
const withCitations = transformCitations(withInlineBlocks, citationPrefs, doc?.citations?.bibliography ?? []);
const html = marked.parse(withCitations, { gfm: true, breaks: false, renderer }) as string;
```

(`doc` here is the same `getActiveDoc()`-derived variable `updatePreview()` already reads earlier in this function for the image-renderer/title lookups — reuse it, don't re-fetch.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test --project=local tests/e2e/local/mmd-citations.spec.ts`
Expected: PASS

- [ ] **Step 5: Run the full local Playwright suite to check for regressions**

Run: `npx playwright test --project=local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Preview.svelte tests/e2e/local/mmd-citations.spec.ts
git commit -m "feat: render citations and a generated bibliography in the preview"
```

---

### Task 4: Compatibility-checker coverage for citations

**Files:**
- Modify: `client/src/markdown-compat.ts`
- Test: `tests/client/src/markdown-compat.test.ts`

**Interfaces:**
- Consumes: `PANDOC_CITATION_RE`, `MULTIMARKDOWN_CITATION_RE` from Task 1.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/markdown-compat.test.ts`:

```ts
test("flags a pandoc-style citation", () => {
  const issues = scanMarkdownCompatibility("A claim.[@Smith2020]", undefined, undefined);
  expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Citation" }));
});

test("flags a multimarkdown-style citation", () => {
  const issues = scanMarkdownCompatibility("A claim.[#Smith2020]", undefined, undefined);
  expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Citation" }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/markdown-compat.test.ts`
Expected: FAIL — the 2 new tests fail (no `"Citation"` label produced yet)

- [ ] **Step 3: Implement**

Add the import near the top of `client/src/markdown-compat.ts`, alongside the existing `mmd-inline-blocks` import:

```ts
import { PANDOC_CITATION_RE, MULTIMARKDOWN_CITATION_RE } from "./mmd-citations";
```

`scanTextToken` (confirmed against the file as it exists today) is:

```ts
function scanTextToken(raw: string, start: number) {
  for (const re of [WIKILINK_RE, FOOTNOTE_REF_RE, MATH_RE, SUPERSCRIPT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const label = re === WIKILINK_RE ? "Wikilink" : re === FOOTNOTE_REF_RE ? "Footnote reference" : re === MATH_RE ? "Math" : "Superscript";
      const category: CompatCategory = re === WIKILINK_RE ? "app-only" : "flavor-specific";
      issues.push({ category, label, from: start + m.index, to: start + m.index + m[0].length });
    }
  }
}
```

Change it to:

```ts
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
```

(Subscript detection lives entirely in the separate `del`-token branch elsewhere in this file, not in this loop — nothing there needs to change; citations need no analogous skip-condition since every match here is a real citation usage, with no double-counting risk.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/markdown-compat.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 5: Typecheck, format, and commit**

```bash
npm run typecheck
npm run format
git add client/src/markdown-compat.ts tests/client/src/markdown-compat.test.ts
git commit -m "feat: flag citations in the compatibility checker"
```

---

### Task 5: `MDEBridge` citation hooks, `app.ts` wiring, and export integration

**Files:**
- Modify: `client/src/types.ts` (`MDEBridge` interface)
- Modify: `client/src/app.ts`

**Interfaces:**
- Consumes: `setActiveDocCitations` (Task 2), `CitationPrefs`/`BibEntry` (Task 1).
- Produces: `MDEBridge.setDocCitations(id, citations): void` and `MDEBridge.onDocCitationsChanged: (...) | null`, declared *and* implemented in this single task — consumed by Tasks 6, 7.

- [ ] **Step 1: Add the `MDEBridge` hooks**

In `client/src/types.ts`, find the `setDocMetadata`/`onDocMetadataChanged` pair and add the parallel citation pair immediately after:

```ts
  setDocCitations(id: string, citations: { prefs: CitationPrefs; bibliography: BibEntry[] }): void;
  onDocCitationsChanged: ((id: string, citations: { prefs: CitationPrefs; bibliography: BibEntry[] }) => void) | null;
```

- [ ] **Step 2: Add the bridge method and null hook in `app.ts`**

Add the `setActiveDocCitations` import from `./stores/docs` alongside the existing `setActiveDocMetadata` import.

In `app.ts`'s `bridge: MDEBridge` object literal, add right after `setDocMetadata`/`onDocMetadataChanged`:

```ts
    setDocCitations(id, citations) {
      if (getActiveDoc()?.id !== id) return;
      setActiveDocCitations(citations);
    },
    onDocCitationsChanged: null,
```

- [ ] **Step 3: Wire structured-mode export into `getResolvedContent()` and `exportAs("md")`**

Add the import: `import { DEFAULT_CITATION_PREFS } from "./mmd-citations";` (alongside the existing `serializeMetadataBlock` import from `./mmd-metadata`).

Add a small local helper right above `exportAs` (or as a standalone function elsewhere in `app.ts` — either is fine, just define it once and use it from both call sites below):

```ts
function serializeCitationsBlock(doc: Doc | undefined, content: string): string {
  const citations = doc?.citations;
  if (!citations || citations.prefs.bibliographySource !== "structured" || citations.bibliography.length === 0) return content;
  const marker = citations.prefs.markerStyle === "pandoc" ? "@" : "#";
  const lines = citations.bibliography.map((entry) => `[${marker}${entry.key}]: ${entry.text}`).join("\n");
  return `${content}\n\n${lines}\n`;
}
```

Change `getResolvedContent()`:

```ts
    getResolvedContent() {
      const doc = getActiveDoc();
      const resolved = resolveDiagramRefs(resolveImageRefs(cm.state.doc.toString(), doc), doc?.diagrams);
      return serializeCitationsBlock(doc, serializeMetadataBlock(doc?.metadata ?? [], resolved));
    },
```

Change `exportAs("md")`'s branch:

```ts
    if (format === "md") {
      const doc = getActiveDoc();
      const resolved = resolveDiagramRefs(resolveImageRefs(raw, doc), doc?.diagrams);
      const withMetadata = serializeMetadataBlock(doc?.metadata ?? [], resolved);
      const withCitations = serializeCitationsBlock(doc, withMetadata);
      downloadBlob(new Blob([withCitations], { type: "text/markdown;charset=utf-8" }), `${base}.md`);
      showToast(`Exported ${base}.md`, "success");
      return;
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors — interface and implementation land together in this task.

- [ ] **Step 5: Manual verification**

Start the app (`npm run dev:client`), open Document Info, switch Bibliography source to Structured, add an entry (Key: `Smith2020`, Author: `Smith, J.`, Year: `2020`, Text: `Title. Publisher.`), type `[@Smith2020]` in the editor, then File → Export → Markdown (.md). Confirm the downloaded file ends with a line reading `[@Smith2020]: Title. Publisher.`.

- [ ] **Step 6: Commit**

```bash
git add client/src/types.ts client/src/app.ts
git commit -m "feat: wire citations into the bridge, Gist publish, and .md export"
```

---

### Task 6: `DocInfoPanel.svelte` — Citations UI section

**Files:**
- Modify: `client/src/components/DocInfoPanel.svelte`
- Modify: `client/src/styles/_diff-view.scss`
- Test: `tests/client/src/components/DocInfoPanel.test.ts`

**Interfaces:**
- Consumes: `setActiveDocCitations` (Task 2), `Doc.citations` (Task 2), `DEFAULT_CITATION_PREFS`/`CitationPrefs`/`BibEntry` (Task 1). Calls `window.MDE.onDocCitationsChanged?.(doc.id, citations)` (Task 5's bridge hook, fully implemented by the time this task runs).

- [ ] **Step 1: Write the failing component tests**

Add to `tests/client/src/components/DocInfoPanel.test.ts` (the file created by the Metadata feature) — same `render()`/`expect.element()` API already established there:

```ts
test("renders the citation preference controls with correct defaults", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByRole("button", { name: "Pandoc [@key]" })).toHaveClass(/active/);
  await expect.element(screen.getByRole("button", { name: "Plain text" })).toHaveClass(/active/);
  await expect.element(screen.getByRole("button", { name: "Numbered" })).toHaveClass(/active/);
});

test("Author-year is disabled when bibliography source is plain text", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByRole("button", { name: "Author-year" })).toBeDisabled();
});

test("switching to Structured enables Author-year and shows entry rows", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Structured" }).click();
  await expect.element(screen.getByRole("button", { name: "Author-year" })).not.toBeDisabled();
  await expect.element(screen.getByPlaceholder("Key")).toBeVisible();
});

test("adding a bibliography entry updates the underlying doc", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Structured" }).click();
  await screen.getByRole("button", { name: "Add entry" }).click();
  const { getActiveDoc } = await import("../../../../client/src/stores/docs");
  expect(getActiveDoc()?.citations?.bibliography).toHaveLength(1);
});
```

(This file's existing `beforeEach` from the Metadata feature already sets `docsStore`/`activeIdStore`/`docInfoPanelOpen` and stubs `window.MDE.formatRelativeTime` — no changes needed there; these tests exercise a document whose `citations` field is `undefined`, i.e. the default state.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts`
Expected: FAIL — no Citations section exists yet

- [ ] **Step 3: Implement the UI**

In `client/src/components/DocInfoPanel.svelte`, add the import and state near the existing metadata handlers:

```ts
import { setActiveDocCitations } from "../stores/docs";
import { DEFAULT_CITATION_PREFS, type CitationPrefs, type BibEntry } from "../mmd-citations";
```

```ts
const citationPrefs = $derived(doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS);
const bibliography = $derived(doc?.citations?.bibliography ?? []);

function updateCitations(prefs: CitationPrefs, bib: BibEntry[]) {
  if (!doc) return;
  const citations = { prefs, bibliography: bib };
  setActiveDocCitations(citations);
  window.MDE.onDocCitationsChanged?.(doc.id, citations);
}

function setMarkerStyle(markerStyle: CitationPrefs["markerStyle"]) {
  updateCitations({ ...citationPrefs, markerStyle }, bibliography);
}

function setBibliographySource(bibliographySource: CitationPrefs["bibliographySource"]) {
  // Falls back to "numbered" when leaving structured mode while
  // author-year was active — author-year has nothing reliable to render
  // once there's no structured author/year data behind it.
  const displayStyle = bibliographySource === "text" && citationPrefs.displayStyle === "author-year" ? "numbered" : citationPrefs.displayStyle;
  updateCitations({ ...citationPrefs, bibliographySource, displayStyle }, bibliography);
}

function setDisplayStyle(displayStyle: CitationPrefs["displayStyle"]) {
  updateCitations({ ...citationPrefs, displayStyle }, bibliography);
}

function addBibEntry() {
  updateCitations(citationPrefs, [...bibliography, { key: "", author: "", year: "", text: "" }]);
}

function updateBibEntry(index: number, field: keyof BibEntry, value: string) {
  updateCitations(
    citationPrefs,
    bibliography.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
  );
}

function removeBibEntry(index: number) {
  updateCitations(
    citationPrefs,
    bibliography.filter((_, i) => i !== index),
  );
}
```

Add the template section after the Metadata section, before `{#if doc.repoPath || doc.gistId}`:

```svelte
<div class="menu-section-label">Citations</div>
<div class="doc-info-citation-prefs">
  <div class="tab-switch" role="tablist">
    <button type="button" class="tab-switch-btn" class:active={citationPrefs.markerStyle === "pandoc"} onclick={() => setMarkerStyle("pandoc")}>Pandoc [@key]</button>
    <button type="button" class="tab-switch-btn" class:active={citationPrefs.markerStyle === "multimarkdown"} onclick={() => setMarkerStyle("multimarkdown")}>MultiMarkdown [#key]</button>
  </div>
  <div class="tab-switch" role="tablist">
    <button type="button" class="tab-switch-btn" class:active={citationPrefs.bibliographySource === "text"} onclick={() => setBibliographySource("text")}>Plain text</button>
    <button type="button" class="tab-switch-btn" class:active={citationPrefs.bibliographySource === "structured"} onclick={() => setBibliographySource("structured")}>Structured</button>
  </div>
  <div class="tab-switch" role="tablist">
    <button type="button" class="tab-switch-btn" class:active={citationPrefs.displayStyle === "numbered"} onclick={() => setDisplayStyle("numbered")}>Numbered</button>
    <button
      type="button"
      class="tab-switch-btn"
      class:active={citationPrefs.displayStyle === "author-year"}
      disabled={citationPrefs.bibliographySource === "text"}
      onclick={() => setDisplayStyle("author-year")}
    >
      Author-year
    </button>
  </div>
</div>
{#if citationPrefs.bibliographySource === "structured"}
  <div class="doc-info-metadata-list">
    {#each bibliography as entry, i}
      <div class="doc-info-citation-row">
        <input type="text" placeholder="Key" value={entry.key} oninput={(e) => updateBibEntry(i, "key", (e.target as HTMLInputElement).value)} />
        <input type="text" placeholder="Author" value={entry.author} oninput={(e) => updateBibEntry(i, "author", (e.target as HTMLInputElement).value)} />
        <input type="text" placeholder="Year" value={entry.year} oninput={(e) => updateBibEntry(i, "year", (e.target as HTMLInputElement).value)} />
        <input type="text" placeholder="Text" value={entry.text} oninput={(e) => updateBibEntry(i, "text", (e.target as HTMLInputElement).value)} />
        <button type="button" class="doc-info-metadata-remove" aria-label="Remove entry" onclick={() => removeBibEntry(i)}>
          <svg class="icon"><use href="#icon-trash-2"></use></svg>
        </button>
      </div>
    {/each}
    <button type="button" class="secondary-btn" onclick={addBibEntry}>Add entry</button>
  </div>
{/if}
```

(`.tab-switch`/`.tab-switch-btn` are this app's existing toggle-button classes — confirmed already used in `Settings.svelte` for the keybinding-mode switcher; reused here verbatim rather than inventing new styling for the same interaction pattern.)

Add to `client/src/styles/_diff-view.scss`, next to `.doc-info-metadata-row`:

```scss
.doc-info-citation-prefs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.doc-info-citation-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;

  input {
    flex: 1;
    min-width: 0;
  }
}
.citation-bibliography {
  margin-top: 24px;
  font-size: 0.9em;

  h2 {
    font-size: 1em;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-dim);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts`
Expected: PASS — adjust exact button label text in the tests if the final markup uses slightly different copy, then confirm green.

- [ ] **Step 5: Typecheck, format, and commit**

```bash
npm run typecheck
npm run format
git add client/src/components/DocInfoPanel.svelte client/src/styles/_diff-view.scss tests/client/src/components/DocInfoPanel.test.ts
git commit -m "feat: add a Citations section to the Document Info panel"
```

---

### Task 7: `collab.ts` — sync `citations` on the Y.Doc `meta` map

**Files:**
- Modify: `client/src/collab.ts`
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `syncRemoteDocContent` (Task 2, new `citations` param), `MDEBridge.setDocCitations`/`onDocCitationsChanged` (Task 5), `EMPTY_CITATIONS` (Task 1).

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/collab.test.ts`'s `describe("shared document name sync", ...)` block, following the exact same shape as the existing `"metadata"` key tests (added by the Metadata feature):

```ts
it("seeds the shared doc's current citations into its Y.Doc meta map when sharing for the first time", async () => {
  const citations = { prefs: { markerStyle: "pandoc" as const, bibliographySource: "structured" as const, displayStyle: "numbered" as const }, bibliography: [{ key: "A", author: "Alpha", year: "2020", text: "Alpha (2020)." }] };
  docsStore.set([{ id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1", citations }]);
  await setAccessMode("anyone-link", "editor");
  for (let i = 0; i < 10; i++) await Promise.resolve();

  const binding = workspaceRoom.docs.get("doc1");
  expect(JSON.parse(binding?.metaMap.get("citations") ?? "null")).toEqual(citations);
});

it("applies a remote citations change on the active doc via MDE.setDocCitations", async () => {
  await setAccessMode("anyone-link", "editor");
  for (let i = 0; i < 10; i++) await Promise.resolve();

  const binding = workspaceRoom.docs.get("doc1")!;
  const remote = { prefs: { markerStyle: "multimarkdown" as const, bibliographySource: "text" as const, displayStyle: "numbered" as const }, bibliography: [] };
  binding.ydoc.transact(() => binding.metaMap.set("citations", JSON.stringify(remote)), "server");

  expect(window.MDE.setDocCitations).toHaveBeenCalledWith("doc1", remote);
});
```

Also add `setDocCitations: vi.fn()` to that `describe` block's `beforeEach`'s `window.MDE` mock object, alongside the existing `setDocMetadata: vi.fn()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: FAIL — `metaMap.get("citations")` is `undefined`; `setDocCitations` never called

- [ ] **Step 3: Implement**

Add the import near the top of `client/src/collab.ts`:

```ts
import { EMPTY_CITATIONS } from "./mmd-citations";
```

In `seedDocBindingFromEditor`, extend the transaction (which already sets `"name"` and `"metadata"`):

```ts
      binding.metaMap.set("citations", JSON.stringify(doc.citations ?? EMPTY_CITATIONS));
```

In `createDocBinding`'s `metaMap.observe(...)`, add a third branch alongside `"name"`/`"metadata"`:

```ts
    if (event.changes.keys.has("citations")) {
      if (workspaceRoom.activeDocId === docId) {
        const raw = metaMap.get("citations");
        if (raw !== undefined) window.MDE.setDocCitations(docId, JSON.parse(raw));
      } else {
        markDirty(docId);
      }
    }
```

In `flushDirtyBackgroundDocs`, extend the read and the `syncRemoteDocContent` call:

```ts
    const citationsRaw = binding.metaMap.get("citations");
    const citations = citationsRaw !== undefined ? JSON.parse(citationsRaw) : undefined;
    if (syncRemoteDocContent(docId, content, images, name, metadata, citations)) changed = true;
```

In `init()`, add the outbound hook right after the existing `window.MDE.onDocMetadataChanged = ...` assignment:

```ts
  window.MDE.onDocCitationsChanged = (docId, citations) => {
    const binding = workspaceRoom.docs.get(docId);
    if (binding) binding.ydoc.transact(() => binding.metaMap.set("citations", JSON.stringify(citations)), "local");
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: sync citations over the workspace room's meta map"
```

---

### Task 8: `repo-sync.ts` — serialize citations into the pushed content

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `tests/client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `BibEntry`/`CitationPrefs` types from Task 1 (types only — this task defines its own small serialization inline, mirroring `app.ts`'s `serializeCitationsBlock` from Task 5, since `repo-sync.ts` doesn't import from `app.ts`).

- [ ] **Step 1: Write the failing test**

Add to `tests/client/src/repo-sync.test.ts`'s `describe("planPush", ...)` block:

```ts
it("appends the document's structured citations as definition lines when pushing", async () => {
  const citations = { prefs: { markerStyle: "pandoc" as const, bibliographySource: "structured" as const, displayStyle: "numbered" as const }, bibliography: [{ key: "Smith2020", author: "Smith, J.", year: "2020", text: "Title. Publisher." }] };
  const docs = [fakeDoc({ id: "d1", name: "My Notes", repoPath: undefined, content: "# Body\n", citations })];
  const plan = await planPush(docs, [], false);
  expect(plan.changes).toHaveLength(1);
  expect(plan.changes[0]!.content).toBe("# Body\n\n[@Smith2020]: Title. Publisher.\n");
});

it("does not append anything when citations are in text mode", async () => {
  const citations = { prefs: { markerStyle: "pandoc" as const, bibliographySource: "text" as const, displayStyle: "numbered" as const }, bibliography: [] };
  const docs = [fakeDoc({ id: "d1", name: "My Notes", repoPath: undefined, content: "# Body\n[@X]\n\n[@X]: Ref.\n", citations })];
  const plan = await planPush(docs, [], false);
  expect(plan.changes[0]!.content).toBe("# Body\n[@X]\n\n[@X]: Ref.\n");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/src/repo-sync.test.ts`
Expected: FAIL — the first test's pushed content has no definition line appended

- [ ] **Step 3: Implement**

Add the import: `import type { BibEntry, CitationPrefs } from "./mmd-citations";`

Add a small helper near `slugFromRepoPath`:

```ts
function serializeCitationsBlock(citations: { prefs: CitationPrefs; bibliography: BibEntry[] } | undefined, content: string): string {
  if (!citations || citations.prefs.bibliographySource !== "structured" || citations.bibliography.length === 0) return content;
  const marker = citations.prefs.markerStyle === "pandoc" ? "@" : "#";
  const lines = citations.bibliography.map((entry) => `[${marker}${entry.key}]: ${entry.text}`).join("\n");
  return `${content}\n\n${lines}\n`;
}
```

Change the push-loop call site (already wrapping `doc.content` in `serializeMetadataBlock` from the Metadata feature):

```ts
const { content, assets } = rewriteImagesForPush(
  serializeCitationsBlock(doc.citations, serializeMetadataBlock(doc.metadata ?? [], doc.content)),
  slugFromRepoPath(repoPath),
  doc.images,
  doc.diagrams,
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/repo-sync.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/repo-sync.ts tests/client/src/repo-sync.test.ts
git commit -m "feat: include structured citations when pushing to a linked repo"
```

---

### Task 9: e2e coverage for the citations UI round-trip

**Files:**
- Modify: `tests/e2e/local/mmd-citations.spec.ts` (created in Task 3)

**Interfaces:**
- Consumes: the fully-wired feature from Tasks 1–8.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/local/mmd-citations.spec.ts`:

```ts
test("adding a structured bibliography entry in Document Info round-trips through .md export", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("A claim.[@Smith2020]");

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.click('button:has-text("Structured")');
  await page.click('button:has-text("Add entry")');
  await page.fill('.doc-info-citation-row input[placeholder="Key"]', "Smith2020");
  await page.fill('.doc-info-citation-row input[placeholder="Author"]', "Smith, J.");
  await page.fill('.doc-info-citation-row input[placeholder="Year"]', "2020");
  await page.fill('.doc-info-citation-row input[placeholder="Text"]', "Title. Publisher.");

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => window.MDE.exportAs("md"));
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("fs");
  const content = fs.readFileSync(path!, "utf-8");
  expect(content).toBe("A claim.[@Smith2020]\n\n[@Smith2020]: Title. Publisher.\n");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test --project=local -g "round-trips through .md export"`
Expected: FAIL until the citations UI/wiring is fully in place (should already pass once Tasks 1–8 are done — this is confirmation, not new implementation)

- [ ] **Step 3: Run it and fix any selector mismatches**

Run: `npx playwright test --project=local -g "round-trips through .md export"`
Expected: PASS

- [ ] **Step 4: Run the full local Playwright suite**

Run: `npx playwright test --project=local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/local/mmd-citations.spec.ts
git commit -m "test: cover the citations UI-to-export round trip end to end"
```

---

### Task 10: Version bump, CHANGELOG, What's New, IMPROVEMENTS.md

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `IMPROVEMENTS.md`
- Create: `client/public/whats-new/citations-and-bibliography.png`

- [ ] **Step 1: Bump the version**

Read `package.json`'s current `"version"`, bump the minor component, hand-edit both `package.json`'s `"version"` and `package-lock.json`'s two `"version"` fields (top-level and `packages[""].version`) — do not run `npm install --package-lock-only`.

- [ ] **Step 2: Add the CHANGELOG entry**

Add a new `## [1.X.0] - 2026-08-29` section at the top of `CHANGELOG.md`:

```markdown
## [1.X.0] - 2026-08-29

### Added

- **Citations & bibliography.** `[@key]` (or `[#key]`, per a new per-document marker-style setting) resolves against a bibliography and renders as a numbered link or an inline `(Author, Year)` — both configurable per document from a new Citations section in Document Info, alongside a choice between typing reference definitions directly in the document (like footnotes) or managing them as structured entries in the panel. Structured entries round-trip as real reference-definition text on `.md` export, Gist publish, and repo push. The Markdown Compatibility Checker now flags citations as flavor-specific.
```

- [ ] **Step 3: Take a real screenshot for What's New**

Start the app locally, type a document with a citation and its definition, open Document Info's Citations section with an entry visible, and capture a screenshot to `client/public/whats-new/citations-and-bibliography.png`, matching the framing of an existing file in that directory (e.g. `multimarkdown-syntax-support.png`).

- [ ] **Step 4: Add the What's New entry**

Append to the end of `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "1.X.0",
    title: "Citations & Bibliography",
    description:
      "Add [@key] or [#key] citations that resolve against a bibliography — numbered or inline author-year style, typed directly in the document or managed as structured entries in a new Citations section in Document Info. Round-trips as real reference text on export, Gist publish, and repo push.",
    screenshot: "/whats-new/citations-and-bibliography.png",
  },
```

(Replace `1.X.0` with the actual version chosen in Step 1.)

- [ ] **Step 5: Update IMPROVEMENTS.md**

Change:

```markdown
- [ ] **Citations & bibliography.** `[#Author2000]`-style citations resolved
      against a bibliography — needs its own bibliography data model and UI,
      split off from the MultiMarkdown syntax support item above as too
      different in kind to bundle with it.
```

to:

```markdown
- [x] **Citations & bibliography.** (Shipped v1.X.0.) `[@key]`/`[#key]`
      citations resolve against a bibliography, with three independent
      per-document settings — marker syntax, bibliography source (typed
      text or a structured Document Info UI), and display style (numbered
      or inline author-year, the latter requiring structured storage).
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/citations-and-bibliography.png IMPROVEMENTS.md
git commit -m "docs: version/changelog/what's-new for citations & bibliography"
```

---

### Task 11: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit/component test suite**

Run: `npm test`
Expected: PASS (all `unit` and `components` project tests)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: PASS

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no errors

- [ ] **Step 5: Full local Playwright e2e suite**

Run: `npm run test:e2e:local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Collab e2e suite**

Run: `npm run test:e2e:collab`
Expected: PASS — exercises the `metaMap` sync path Task 7 touched.

- [ ] **Step 7: Manual smoke test**

Using `npm run dev` (after `npm run build`): type a citation with a typed definition and confirm it renders with a bibliography; switch to Structured mode, add an entry, confirm Author-year becomes available and renders correctly; confirm a citation field persists across a reload; confirm the Author-year-disabled-in-text-mode constraint is visible and correct in the UI.

- [ ] **Step 8: Hand off to finishing-a-development-branch**

Once all of the above are green, proceed to `superpowers:finishing-a-development-branch`.
