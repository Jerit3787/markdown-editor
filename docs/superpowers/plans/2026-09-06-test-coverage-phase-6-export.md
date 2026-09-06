# Test Coverage Phase 6 — Export & print

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Close the `gap` / `partial` rows in `docs/TEST-COVERAGE.md` §6. Small phase — 6 rows, all e2e, all extending `tests/e2e/local/export.spec.ts`. No app code changes.

**Architecture:** `exportAs` / `buildStandaloneHtml` / `currentFileBase` are closures in `app.ts` reached via `window.MDE.exportAs(fmt)`. Downloads are read from disk (`download.path()` + `fs.readFile`). The existing spec's `beforeEach` types a mermaid fence — the new tests set their own content, so add them outside that describe or override in the test.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`

## Global Constraints

- Off master (Phases 1–5 merged). Patch `1.45.7` → `1.45.8`; `package.json` + `package-lock.json`; `CHANGELOG.md` `## [1.45.8]` `### Changed`. No `whats-new`.
- No app code changes. Bug → trivial fix in-PR + `### Fixed`; non-trivial → `test.fixme` + `## Deferred` + flag.
- Format before every commit; run `npx playwright test --project=local tests/e2e/local/export.spec.ts` after each task. Known pre-existing local-only failures: `images.spec` "Replace on a row", `mobile-input-zoom` "16px".

## Rows

| Row | What |
| --- | ---- |
| EXP-01 | `.md` export resolves diagram refs → source, image refs → data URI, re-serializes metadata + citations |
| EXP-02 | `.md` export → re-import round-trip preserves metadata / citations / content |
| EXP-03 | `.txt` export content is the preview's rendered text (no `#` / `**` markdown syntax) |
| EXP-05 | `.html` export inlines the stylesheet (and KaTeX CSS when there's math) |
| EXP-06 | `.html` export escapes the document title so it can't inject markup |
| EXP-08 | Export filename derives from the sanitized document name (`currentFileBase`) |

Everything else in §6 is already `covered`.

---

## Task 1: EXP-01 + EXP-02 — `.md` export fidelity + round-trip

**Files:** Modify `tests/e2e/local/export.spec.ts`.

- [ ] **Step 1:** Add a top-level `test.describe("markdown export", ...)` (not sharing the mermaid `beforeEach`):

```ts
test.describe("markdown export", () => {
  async function readMd(page: import("@playwright/test").Page): Promise<{ file: string; content: string }> {
    const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("md"))]);
    const p = await download.path();
    const fs = await import("node:fs/promises");
    return { file: download.suggestedFilename(), content: p ? await fs.readFile(p, "utf-8") : "" };
  }

  test("EXP-01: resolves a diagram ref to its source, an image ref to a data URI, and re-serializes metadata + citations", async ({ page }) => {
    await page.evaluate(async (b64) => {
      const { setDocDiagram, setActiveDocMetadata, setActiveDocCitations } = await import("/src/stores/docs.ts");
      setDocDiagram("d-key", "flowchart TD\n  A --> B");
      setActiveDocMetadata([{ key: "Title", value: "Exported" }]);
      setActiveDocCitations({
        prefs: { markerStyle: "pandoc", bibliographySource: "structured", displayStyle: "numbered" },
        bibliography: [{ key: "S1", author: "Smith", year: "2020", text: "A Title." }],
      });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.MDE.insertImageWithUpload!(new File([bytes], "pic.png", { type: "image/png" }));
    }, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
    // Body: an image ref + a diagram fence referencing d-key + a citation.
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "See [@S1].\n\n![pic](pic.png)\n\n```mermaid\nd-key\n```" } });
    });

    const { content } = await readMd(page);
    expect(content).toMatch(/^<!--\nTitle: Exported\n-->/);       // metadata block
    expect(content).toContain("flowchart TD");                     // diagram source, not "d-key"
    expect(content).not.toMatch(/```mermaid\nd-key\n```/);
    expect(content).toContain("![pic](data:image/png;base64,");    // image ref resolved
    expect(content).toContain("[@S1]: A Title.");                  // citations re-serialized
  });

  test("EXP-02: the exported .md re-imports to an equivalent document", async ({ page }) => {
    await page.evaluate(async () => {
      const { setActiveDocMetadata } = await import("/src/stores/docs.ts");
      setActiveDocMetadata([{ key: "Author", value: "Ada" }]);
    });
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Heading\n\nBody paragraph." } });
    });
    const { content } = await readMd(page);

    const reimported = await page.evaluate((md) => {
      // createDoc splits a leading metadata block out of imported content.
      return import("/src/stores/docs.ts").then((m) => {
        const d = m.createDoc({ name: "Reimported", content: md });
        return { content: d.content, metadata: d.metadata ?? [] };
      });
    }, content);
    expect(reimported.content.trim()).toBe("# Heading\n\nBody paragraph.");
    expect(reimported.metadata).toEqual([{ key: "Author", value: "Ada" }]);
  });
});
```

- [ ] **Step 2:** Run. Pin the exact serialized forms against `serializeMetadataBlock` / `serializeCitationsBlock` output (metadata may be `<!--\nTitle: Exported\n-->` with or without a trailing blank line; the citation definition line format is whatever `serializeCitationsBlock` emits — read it). The invariants: diagram *source* present (not the ref key), image is a `data:` URI, metadata + citation blocks round-trip.

- [ ] **Step 3:** Commit — `test(export): EXP-01/02 — .md export fidelity and re-import round-trip`

---

## Task 2: EXP-03 + EXP-05 + EXP-06 — txt content, html inlining, html title escaping

**Files:** Modify `tests/e2e/local/export.spec.ts`.

- [ ] **Step 1:** Add:

```ts
test.describe("txt and html export content", () => {
  async function readExport(page: import("@playwright/test").Page, fmt: "txt" | "html") {
    const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate((f) => window.MDE.exportAs(f), fmt)]);
    const p = await download.path();
    const fs = await import("node:fs/promises");
    return p ? await fs.readFile(p, "utf-8") : "";
  }

  test("EXP-03: .txt export is the rendered text — no markdown syntax", async ({ page }) => {
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Big Heading\n\nSome **bold** and _italic_ words." } });
    });
    const txt = await readExport(page, "txt");
    expect(txt).toContain("Big Heading");
    expect(txt).toContain("bold");
    expect(txt).not.toContain("#");
    expect(txt).not.toContain("**");
    expect(txt).not.toContain("_italic_");
  });

  test("EXP-05: .html export inlines the stylesheet, and KaTeX CSS when the doc has math", async ({ page }) => {
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "text $x^2$ more" } });
    });
    await expect(page.locator("#preview .katex")).toBeVisible();
    const html = await readExport(page, "html");
    expect(html).toMatch(/<style>[\s\S]*body\s*\{/); // base stylesheet inlined
    expect(html.toLowerCase()).toContain(".katex"); // katex css inlined (doc has math)
  });

  test("EXP-06: the exported .html escapes the document title so it can't inject markup", async ({ page }) => {
    await page.fill("#docTitle", "<script>alert(1)</script>");
    await page.keyboard.press("Enter");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "body" } });
    });
    const html = await readExport(page, "html");
    // The <title> holds the escaped form, never a raw <script>.
    expect(html).toMatch(/<title>&lt;script&gt;/);
    expect(html).not.toContain("<title><script>");
  });
});
```

- [ ] **Step 2:** Run. If `.txt` still contains a stray `#` from something unexpected (a URL fragment, an emoji), tighten to `expect(txt).not.toMatch(/^#\s/m)`. If `escapeHtml` produces `&#60;` rather than `&lt;`, match that. The `#docTitle` fill + Enter is how `renameActiveDoc` commits (see `formatting.spec` / other specs) — confirm the selector.

- [ ] **Step 3:** Commit — `test(export): EXP-03/05/06 — txt content shape, html style inlining, html title escaping`

---

## Task 3: EXP-08 — filename from sanitized doc name

**Files:** Modify `tests/e2e/local/export.spec.ts`.

- [ ] **Step 1:** Add:

```ts
test("EXP-08: the export filename derives from the sanitized document name", async ({ page }) => {
  await page.fill("#docTitle", 'Quarterly: Report? <v2>');
  await page.keyboard.press("Enter");
  const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("md"))]);
  // currentFileBase() replaces \ / : * ? " < > | runs with a single "-".
  expect(download.suggestedFilename()).toBe("Quarterly- Report- -v2-.md");
});
```

- [ ] **Step 2:** Run. Pin the exact expected filename against `currentFileBase`'s real regex output — `name.replace(/[\\/:*?"<>|]+/g, "-")` collapses each *run* of unsafe chars to one `-`, keeps spaces. `"Quarterly: Report? <v2>"` → `"Quarterly- Report- -v2-"`. Verify against the first run and pin whatever it actually is.

- [ ] **Step 3:** Commit — `test(export): EXP-08 — export filename from the sanitized document name`

---

## Task 4: Catalog, version, changelog, PR

- [ ] **Step 1:** Flip §6 rows EXP-01, 02, 03, 05, 06, 08 to `covered` (+ path `tests/e2e/local/export.spec.ts`). Update `## Baseline` §6 row (`6 / 2 / 4` → `12 / 0 / 0`) + total (`228/19/60` → `234/17/54`) + percentage (~76%).
- [ ] **Step 2:** Version `1.45.7` → `1.45.8`.
- [ ] **Step 3:** `CHANGELOG.md` `## [1.45.8] - <today>` `### Changed`: "Expanded automated test coverage for export (`docs/TEST-COVERAGE.md` §6, now fully covered): `.md` export fidelity (diagram source, image data URIs, metadata + citation blocks) and its re-import round-trip, `.txt` rendered-text content, `.html` stylesheet inlining and title escaping, and export filename sanitization."
- [ ] **Step 4:** `npm run format && npm test && npm run typecheck && npm run format:check && npm run build && npm run test:e2e:local`.
- [ ] **Step 5:** Commit `docs: mark §6 export rows covered + v1.45.8`, push, open PR (base master).

---

## Self-Review

**Spec coverage:** every §6 gap/partial has a task (01→T1, 02→T1, 03→T2, 05→T2, 06→T2, 08→T3). ✅
**Placeholder scan:** every test body is literal; the "pin the exact form" notes are real (serializer output / escape entity form / filename regex must be observed once) and each names the invariant. ✅
**Scope:** ~7 new tests, one file, no app code, one PR. ✅
