# Test Coverage Phase 5 — Images

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Close the `gap` / `partial` rows in `docs/TEST-COVERAGE.md` §5 that don't need a live collab room.

**Architecture:** `imageKey` is unit-covered. The gaps are the paste/drop DOM-event path and the Images modal, both only meaningful through the real editor — e2e (extends `images.spec.ts`) plus one `ImagesModal` component test. `imageFilesFrom` / the drop handler are closures inside `Editor.svelte`, so they're exercised via real `drop`/`paste` events dispatched on `.cm-content`. No app code changes.

**Tech Stack:** Playwright `local`; existing `images.spec.ts` uses `window.MDE.insertImageWithUpload(file)` directly and a 1x1 PNG base64 constant. A real drop = `page.evaluate` building a `DataTransfer` + dispatching `new DragEvent("drop", {dataTransfer, clientX, clientY, bubbles})` on `.cm-content`.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`

## Global Constraints

- Branches off master (Phases 1–4 merged). Patch `1.45.6` → `1.45.7`; `package.json` + `package-lock.json`; `CHANGELOG.md` `## [1.45.7]` `### Changed`. No `whats-new`.
- No app code changes. Bug → trivial fix in-PR + `### Fixed`; non-trivial → `test.fixme` + `## Deferred` + flag.
- Format before every commit; run the touched file after each task. Known pre-existing local-only failures: `images.spec` "Replace on a row", `mobile-input-zoom` "16px".

## Rows

| Row | What | File |
| --- | ---- | ---- |
| IMG-03 | Dropping an image file embeds it | extend `images.spec.ts` |
| IMG-04 | Oversized (>2 MB) → error marker on **drop** too (paste covered) | extend `images.spec.ts` |
| IMG-05 | A non-image paste / drop payload is ignored | extend `images.spec.ts` |
| IMG-07 | Switching documents mid-encode drops the pending image | extend `images.spec.ts` |
| IMG-12 | Deleting an image from the Images modal removes it from the doc's image map | new `ImagesModal.test.ts` (component) |
| IMG-13 | The Images modal shows each image's size | `ImagesModal.test.ts` |
| IMG-14 | Pasting the same file twice → two distinct keys (no content dedup) | extend `image-key.test.ts` (unit) |
| IMG-15 | `![](key)` resolves to its data URI in the rendered preview | extend `images.spec.ts` |

**Deferred to §10:** IMG-06 (placeholder position tracked across a collaborator's concurrent edits — needs a shared doc).

---

## Task 1: IMG-14 — no content-hash dedup (`image-key.test.ts`, unit)

**Files:** Modify `tests/client/src/image-key.test.ts`.

- [ ] **Step 1:** Add a test pinning that `imageKey` is filename-based, so the same file pasted twice gets `name` then `name-2`:

```ts
it("gives the same filename a fresh suffixed key each time — there is no content-hash dedup", () => {
  const images: Record<string, string> = {};
  const k1 = imageKey("photo.png", images);
  images[k1] = "data:image/png;base64,AAAA";
  const k2 = imageKey("photo.png", images);
  images[k2] = "data:image/png;base64,AAAA"; // byte-identical content
  const k3 = imageKey("photo.png", images);
  expect(k1).toBe("photo.png");
  expect(k2).toBe("photo-2.png");
  expect(k3).toBe("photo-3.png");
});
```

- [ ] **Step 2:** Run `npx vitest run tests/client/src/image-key.test.ts`. Pin the exact suffixed forms against `imageKey`'s real output if they differ (`photo-2.png` vs `photo_2.png` etc.).

- [ ] **Step 3:** Commit — `test(images): IMG-14 — imageKey is filename-based, no content dedup`

---

## Task 2: IMG-03 + IMG-04 + IMG-05 — drop-event path (`images.spec.ts`)

**Files:** Modify `tests/e2e/local/images.spec.ts`.

- [ ] **Step 1:** Add a helper + tests:

```ts
async function dropFile(page: import("@playwright/test").Page, name: string, type: string, bytes: Uint8Array | number) {
  await page.evaluate(
    ({ name, type, bytes }) => {
      const data = typeof bytes === "number" ? new Uint8Array(bytes) : Uint8Array.from(bytes as number[]);
      const file = new File([data], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector("#editor-mount .cm-content")!;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: r.x + 5, clientY: r.y + 5, bubbles: true, cancelable: true }));
    },
    { name, type, bytes: bytes instanceof Uint8Array ? Array.from(bytes) : bytes },
  );
}

const PIXEL_BYTES = Array.from(Uint8Array.from(atob(PIXEL_PNG_BASE64), (c) => c.charCodeAt(0)));

test("IMG-03: dropping an image file onto the editor embeds it", async ({ page }) => {
  await dropFile(page, "dropped.png", "image/png", PIXEL_BYTES as unknown as Uint8Array);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[dropped\]\(dropped\.png\)/);
  const images = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]")[0]?.images ?? {});
  expect(images["dropped.png"]).toMatch(/^data:image\/png;base64,/);
});

test("IMG-04: dropping an oversized image inserts the too-large marker, not the image", async ({ page }) => {
  await dropFile(page, "huge.png", "image/png", 3 * 1024 * 1024);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("huge.png: image too large, 2MB max");
});

test("IMG-05: dropping a non-image file is ignored (no marker, no ref)", async ({ page }) => {
  await dropFile(page, "notes.txt", "text/plain", Array.from(new TextEncoder().encode("hello")) as unknown as Uint8Array);
  await page.waitForTimeout(200);
  const doc = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());
  expect(doc).not.toContain("notes.txt");
  expect(doc).not.toContain("Encoding");
});
```

- [ ] **Step 2:** Run `npx playwright test --project=local tests/e2e/local/images.spec.ts`. If `DragEvent` / `DataTransfer` isn't constructible in the page context, fall back to a `new Event("drop")` with a manually-attached `dataTransfer` object (`{ files: [file], items: [...] }`) — CodeMirror reads `event.dataTransfer`. If CodeMirror's `posAtCoords` returns null for the synthetic coords and the image lands at the current cursor instead of the drop point, that's still IMG-03 passing (embed happened) — assert the embed, not the exact offset, and note it.

- [ ] **Step 3:** Commit — `test(images): IMG-03/04/05 — drop path embeds, rejects oversized, ignores non-images`

---

## Task 3: IMG-07 — switch-doc mid-encode (`images.spec.ts`)

**Files:** Modify `tests/e2e/local/images.spec.ts`.

- [ ] **Step 1:** Add:

```ts
test("IMG-07: switching documents before the FileReader resolves drops the pending image", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "imgother", name: "Img Other" });
    switchDoc("e2e-doc-1");
  });
  // insertImageWithUpload inserts the placeholder synchronously, then reads
  // the file async — switch away in the same tick, before onload fires.
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "raced.png", { type: "image/png" });
    window.MDE.insertImageWithUpload!(file);
    window.MDE.switchDoc("imgother");
  }, PIXEL_PNG_BASE64);
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return {
      other: docs.find((d: { id: string }) => d.id === "imgother"),
      orig: docs.find((d: { id: string }) => d.id === "e2e-doc-1"),
    };
  });
  // The image never landed in either document, and no stray placeholder remains.
  expect(Object.keys(state.other?.images ?? {})).not.toContain("raced.png");
  expect(Object.keys(state.orig?.images ?? {})).not.toContain("raced.png");
  expect(state.other?.content ?? "").not.toContain("Encoding");
  expect(await page.evaluate(() => window.MDE.getEditor().state.doc.toString())).not.toContain("Encoding");
});
```

- [ ] **Step 2:** Run. If the FileReader for a 68-byte PNG resolves *synchronously enough* that the image still lands (race won by the reader), make the file bigger (~500 KB of zeros, still < 2 MB) so the read genuinely outlasts the `switchDoc`. If it still can't be made to lose reliably, move IMG-07 to `## Deferred` noting "FileReader timing not controllable enough in e2e; the `if (!range) return` guard is exercised structurally by the marker-field reset on doc switch".

- [ ] **Step 3:** Commit — `test(images): IMG-07 — a doc switch mid-encode drops the pending image`

---

## Task 4: IMG-15 — preview resolves `![](key)` (`images.spec.ts`)

**Files:** Modify `tests/e2e/local/images.spec.ts`.

- [ ] **Step 1:** Add:

```ts
test("IMG-15: a ![](key) reference renders as an <img> with the resolved data URI in the preview", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.MDE.insertImageWithUpload!(new File([bytes], "shown.png", { type: "image/png" }));
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[shown\]\(shown\.png\)/);

  const img = page.locator('#preview img[alt="shown"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
});
```

- [ ] **Step 2:** Run.

- [ ] **Step 3:** Commit — `test(images): IMG-15 — preview resolves an image ref to its data URI`

---

## Task 5: IMG-12 + IMG-13 — Images modal (`ImagesModal.test.ts`, component)

**Files:** Create `tests/client/src/components/ImagesModal.test.ts`.

**Context:** `ImagesModal.svelte` imports `docsStore, activeIdStore, deleteDocImage, setDocImage, getActiveDoc` from stores/docs, `imagesModalOpen` from stores/imagesModal. It renders `.image-item` per image, a delete control per row, and `formatBytes(base64Length)` for the size. Follow `DocInfoPanel.test.ts` for the mount + store setup (`vitest-browser-svelte`, set stores in `beforeEach`, `window.MDE` stub with `getEditor`). The `#body` guard is already in `vitest.setup.browser.ts`.

- [ ] **Step 1:** Read `ImagesModal.svelte` for the real per-row delete selector (button aria-label / class) and where the size text renders. Then:

```ts
// beforeEach: docsStore = [{ id:"d1", images: { "a.png": "data:image/png;base64,AAAA", "b.png": "data:...longer..." } }]
//             activeIdStore "d1"; imagesModalOpen.set(true); window.MDE = { getEditor: () => ({ state:{...}, dispatch(){} }), setDocImage: vi.fn() }

test("IMG-12: deleting an image row removes it from the doc's image map and the list", async () => {
  // render; expect 2 .image-item; click the delete control on the "a.png" row
  // expect get(docsStore)[0].images has no "a.png"; expect 1 .image-item left
});

test("IMG-13: each row shows its image size", async () => {
  // render; expect the "a.png" row to show a human size (e.g. matches /\d+(\.\d+)?\s?(B|KB|MB)/)
});
```

- [ ] **Step 2:** Run `npx vitest run --project=components tests/client/src/components/ImagesModal.test.ts`. If deleting an image needs `window.MDE.getEditor()` to return a usable view (the modal may dispatch an editor change to strip the `![](key)` line), stub it with a minimal fake `{ state: { doc: { toString: () => "" }, ... }, dispatch: vi.fn() }` — or if that's too involved, cover IMG-13 (size display, pure render) and move IMG-12 to `## Deferred` noting the store fn `deleteDocImage` is unit-covered in `stores/docs.test.ts`.

- [ ] **Step 3:** Commit — `test(images): IMG-12/13 — Images modal delete + size display`

---

## Task 6: Catalog, version, changelog, PR

- [ ] **Step 1:** Flip §5 rows IMG-03, 04, 05, 07, 12, 13, 14, 15 to `covered` (+ paths). IMG-06 stays deferred (§10). Anything else not closed → `## Deferred`. Update `## Baseline` §5 row (`6 / 2 / 7`) + total + percentage.
- [ ] **Step 2:** Version `1.45.6` → `1.45.7`.
- [ ] **Step 3:** `CHANGELOG.md` `## [1.45.7] - <today>` `### Changed`: "Expanded automated test coverage for images (`docs/TEST-COVERAGE.md` §5): dropping images (embed, oversized rejection, non-image filter), a document switch mid-encode dropping the pending image, the Images modal's delete and size display, no content-hash dedup, and preview resolution of image references."
- [ ] **Step 4:** `npm run format && npm test && npm run typecheck && npm run format:check && npm run build && npm run test:e2e:local`.
- [ ] **Step 5:** Commit `docs: mark §5 image rows covered + v1.45.7`, push, open PR (base master).

---

## Self-Review

**Spec coverage:** every §5 gap/partial except IMG-06 has a task (03→T2, 04→T2, 05→T2, 07→T3, 12→T5, 13→T5, 14→T1, 15→T4). IMG-06 deferred to §10. ✅
**Placeholder scan:** Task 5 carries `//` sketches because the ImagesModal delete/size DOM must be read first — each names the fallback (cover IMG-13, defer IMG-12). Tasks 1–4 have literal bodies. Task 2/3 name the concrete fallback if the synthetic event / FileReader race doesn't behave. ✅
**Scope:** ~10 new tests across 3 files (1 unit ext, 1 e2e ext, 1 new component spec), no app code, one PR. ✅
