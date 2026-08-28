# Insert Existing Image & Replace Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The toolbar's "Insert image" action opens the existing Images modal instead of the OS file picker directly, letting a user click an existing thumbnail to insert it, upload a new one from inside the modal, or replace an existing image's underlying file in place.

**Architecture:** `formatting-commands.ts`'s `insertImage()` is redirected to open `imagesModalOpen` (already used by "Manage images"). `ImagesModal.svelte` gains three additions — click-to-insert on each thumbnail, an "Upload new image" button (its own local hidden file input, reusing `window.MDE.insertImageWithUpload`), and a per-row "Replace" button (a second local hidden file input plus a small `setDocImage`-based overwrite) — all scoped to the one file that already owns this modal's markup and logic.

**Tech Stack:** Svelte 5 (runes), CodeMirror 6 (`window.MDE.getEditor()`), Playwright (`tests/e2e/local`).

**Spec:** `docs/superpowers/specs/2026-08-28-image-picker-and-replace-design.md`

## Global Constraints

- Scope is local (never-shared) documents only — reads/writes `doc.images`, no `imagesMap` (shared-doc) handling added.
- `MAX_IMAGE_BYTES = 2 * 1024 * 1024` (2MB) for the replace path, matching `Editor.svelte`'s existing upload limit.
- Insertion format is exactly `` `![${alt}](${key})` ``, inserted at `view.state.selection.main.head` with no `to` (a zero-width insertion, never replacing an existing selection) — matching `Editor.svelte`'s own `insertImageWithUpload`.
- Replace never calls `window.MDE.onImageAdded` (no collab-sync push) — matches this modal's existing `deleteDocImage` precedent, which also doesn't sync deletes to collaborators.
- Replace uses `setDocImage` imported directly from `../stores/docs` (a per-key merge + `persistDocs()`), not the `window.MDE.setDocImage` bridge method (that bridge always pairs with `onImageAdded`, which this plan explicitly excludes).

---

### Task 1: Redirect "Insert image" to open the Images modal

**Files:**
- Modify: `client/src/formatting-commands.ts:92-94`
- Test: `tests/e2e/local/images.spec.ts`

**Interfaces:**
- Consumes: `imagesModalOpen` (existing writable, `client/src/stores/imagesModal.ts`), already imported by `ImagesModal.svelte`.
- Produces: `insertImage()` keeps its existing signature (`() => void`) and existing callers (`Toolbar.svelte`'s Image button, `CommandPalette.svelte`'s "Insert image" entry both call `runCmd("image")` — neither needs any change).

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e/local/images.spec.ts` (after the existing two tests, before the closing of the file):

```ts
test("clicking the toolbar Insert image button opens the Images modal", async ({ page }) => {
  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "opens the Images modal"`
Expected: FAIL — the modal never appears (today's `insertImage()` just clicks the hidden `#imageFileInput`, which opens an OS file dialog Playwright doesn't see as any DOM change).

- [ ] **Step 3: Write minimal implementation**

In `client/src/formatting-commands.ts`, add the import at the top of the file:

```ts
import { linkModalOpen, linkModalPrefillText } from "./stores/linkModal";
import { imagesModalOpen } from "./stores/imagesModal";
```

Replace the existing `insertImage` function body:

```ts
export function insertImage() {
  imagesModalOpen.set(true);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "opens the Images modal"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/formatting-commands.ts tests/e2e/local/images.spec.ts
git commit -m "feat: Insert image opens the Images modal instead of the file picker"
```

---

### Task 2: Click a thumbnail to insert an existing image

**Files:**
- Modify: `client/src/components/ImagesModal.svelte`
- Test: `tests/e2e/local/images.spec.ts`

**Interfaces:**
- Consumes: `window.MDE.getEditor()` (existing bridge method, returns the live CodeMirror `EditorView`), `close()` (existing local function in this file).
- Produces: `insertExisting(key: string): void` — new local function, not consumed outside this file.

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e/local/images.spec.ts`:

```ts
test("clicking a thumbnail in the Images modal inserts a reference and closes the modal", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(file);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);

  await page.evaluate(() => {
    const view = window.MDE.getEditor();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });

  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
  await page.click(".image-item img");

  await expect(page.getByText("Images in this document")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("![pixel](pixel.png)![pixel](pixel.png)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "clicking a thumbnail"`
Expected: FAIL — clicking the `<img>` does nothing today (no `onclick` handler on it), so the document text stays at one reference and the modal never closes (timeout waiting for it to hide).

- [ ] **Step 3: Write minimal implementation**

In `client/src/components/ImagesModal.svelte`, add this function alongside the existing `removeImage`/`formatBytes` functions (after `formatBytes`, before `removeImage`):

```ts
  function insertExisting(key: string) {
    const view = window.MDE.getEditor();
    const alt = key.replace(/\.[^.]+$/, "") || "image";
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: `![${alt}](${key})` } });
    view.focus();
    close();
  }
```

Update the `<img>` element inside the `{#each images as img (img.key)}` loop (currently `<img src={img.dataUrl} alt="" />`):

```svelte
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <img
              src={img.dataUrl}
              alt=""
              role="button"
              tabindex="0"
              class="image-item-thumb"
              title="Click to insert"
              onclick={() => insertExisting(img.key)}
            />
```

In `client/src/styles/_utilities.scss`, inside the existing `.image-item { img { ... } }` block (around line 328), add a cursor rule — the block currently reads:

```scss
  img {
    width: 44px;
    height: 44px;
    object-fit: cover;
    border-radius: 6px;
    background: var(--bg-alt);
    flex-shrink: 0;
```

Add `cursor: pointer;` as the last property in that block, right before its closing `}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "clicking a thumbnail"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ImagesModal.svelte client/src/styles/_utilities.scss tests/e2e/local/images.spec.ts
git commit -m "feat: click a thumbnail in the Images modal to insert it"
```

---

### Task 3: "Upload new image" button inside the modal

**Files:**
- Modify: `client/src/components/ImagesModal.svelte`
- Test: `tests/e2e/local/images.spec.ts`

**Interfaces:**
- Consumes: `window.MDE.insertImageWithUpload` (existing bridge method, `(file: File, pos?: number) => void`).
- Produces: `onUploadChange(e: Event): void` — new local function, not consumed outside this file. New DOM id `#imagesUploadInput` (test-addressable hook, see Testing note in the spec).

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e/local/images.spec.ts` (this file already needs `Buffer` — it's a Node global, no import needed in a Playwright test file):

```ts
test("Upload new image button inside the modal inserts a new image and closes the modal", async ({ page }) => {
  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();

  await page.locator("#imagesUploadInput").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(PIXEL_PNG_BASE64, "base64"),
  });

  await expect(page.getByText("Images in this document")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "Upload new image button"`
Expected: FAIL — `#imagesUploadInput` doesn't exist yet (`page.locator(...).setInputFiles()` throws/times out finding zero elements).

- [ ] **Step 3: Write minimal implementation**

In `client/src/components/ImagesModal.svelte`, add this function alongside `insertExisting`:

```ts
  let uploadInputEl: HTMLInputElement;

  function onUploadChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!file) return;
    close();
    window.MDE.insertImageWithUpload?.(file);
  }
```

In the template, immediately after the `{#snippet quickAction()}...{/snippet}` block and before the `{#if images.length === 0}` line, add:

```svelte
    <div class="images-modal-upload-row">
      <button type="button" class="secondary-btn" onclick={() => uploadInputEl.click()}>
        <svg class="icon"><use href="#icon-upload"></use></svg> Upload new image
      </button>
      <input id="imagesUploadInput" type="file" accept="image/*" hidden bind:this={uploadInputEl} onchange={onUploadChange} />
    </div>
```

In `client/src/styles/_utilities.scss`, add a new rule right after the `.images-list { ... }` block (around line 319, after its closing `}`):

```scss
.images-modal-upload-row {
  margin-bottom: 10px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "Upload new image button"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ImagesModal.svelte client/src/styles/_utilities.scss tests/e2e/local/images.spec.ts
git commit -m "feat: add an Upload new image button inside the Images modal"
```

---

### Task 4: Per-row "Replace" action

**Files:**
- Modify: `client/src/components/ImagesModal.svelte`
- Test: `tests/e2e/local/images.spec.ts`

**Interfaces:**
- Consumes: `setDocImage(key: string, dataUrl: string): void` (existing export, `client/src/stores/docs.ts`), `showToast(message: string, type?: ToastType): void` (existing export, `client/src/stores/toast.ts`), `window.MDE.updatePreview()` (existing bridge method).
- Produces: `startReplace(key: string): void`, `onReplaceChange(e: Event): void` — new local functions, not consumed outside this file. New DOM id `#imagesReplaceInput`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/e2e/local/images.spec.ts`:

```ts
test("Replace on a row overwrites the same key without changing the document text", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(file);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);
  const originalText = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());

  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
  await page.click('button[aria-label="Replace pixel.png"]');

  // A second, different 1x1 PNG (red pixel) so the data URL differs from the original.
  const RED_PIXEL_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await page.locator("#imagesReplaceInput").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(RED_PIXEL_PNG_BASE64, "base64"),
  });

  // Replace doesn't close the modal — confirm it's still open.
  await expect(page.getByText("Images in this document")).toBeVisible();

  const finalText = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());
  expect(finalText).toBe(originalText);

  const images = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return docs[0]?.images ?? {};
  });
  expect(images["pixel.png"]).not.toBe(
    "data:image/png;base64," + PIXEL_PNG_BASE64,
  );
  expect(images["pixel.png"]).toMatch(/^data:image\/png;base64,/);
});

test("Replacing with an oversized file shows an error and leaves the original image untouched", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(file);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);
  const originalImages = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return docs[0]?.images ?? {};
  });

  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
  await page.click('button[aria-label="Replace pixel.png"]');

  await page.locator("#imagesReplaceInput").setInputFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(3 * 1024 * 1024),
  });

  await expect(page.getByText("Image too large (2MB max).")).toBeVisible();
  const imagesAfter = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return docs[0]?.images ?? {};
  });
  expect(imagesAfter["pixel.png"]).toBe(originalImages["pixel.png"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "Replace"`
Expected: FAIL — there is no `button[aria-label="Replace pixel.png"]` or `#imagesReplaceInput` yet.

- [ ] **Step 3: Write minimal implementation**

In `client/src/components/ImagesModal.svelte`, update the imports at the top of the `<script>` block — the existing import line:

```ts
  import { docsStore, activeIdStore, deleteDocImage, getActiveDoc } from "../stores/docs";
```

becomes:

```ts
  import { docsStore, activeIdStore, deleteDocImage, setDocImage, getActiveDoc } from "../stores/docs";
```

and add a new import for `showToast`:

```ts
  import { showToast } from "../stores/toast";
```

Add this state and these functions alongside `uploadInputEl`/`onUploadChange` (from Task 3):

```ts
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

  let replaceInputEl: HTMLInputElement;
  let replaceKey = $state<string | null>(null);

  function startReplace(key: string) {
    replaceKey = key;
    replaceInputEl.click();
  }

  function onReplaceChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    const key = replaceKey;
    replaceKey = null;
    if (!file || !key) return;
    if (file.size > MAX_IMAGE_BYTES) {
      showToast("Image too large (2MB max).", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setDocImage(key, reader.result as string);
      window.MDE.updatePreview();
    };
    reader.readAsDataURL(file);
  }
```

Add the hidden replace input once, in the template right after the upload input added in Task 3:

```svelte
      <input id="imagesReplaceInput" type="file" accept="image/*" hidden bind:this={replaceInputEl} onchange={onReplaceChange} />
```

Add a Replace button in each row, right before the existing Delete button (which currently reads `<button class="icon-btn" title="Delete image" aria-label={\`Delete ${img.key}\`} onclick={() => removeImage(img.key)}>`):

```svelte
            <button class="icon-btn" title="Replace image" aria-label={`Replace ${img.key}`} onclick={() => startReplace(img.key)}>
              <svg class="icon"><use href="#icon-replace"></use></svg>
            </button>
```

`#icon-replace` doesn't exist in `client/index.html`'s icon sprite sheet yet. Add this symbol next to the existing `#icon-undo-2`/`#icon-redo-2` symbols (same `viewBox="0 0 24 24"` convention as every other icon in that file) — this is the Lucide "replace" glyph:

```html
      <symbol id="icon-replace" viewBox="0 0 24 24">
        <path d="M14 4c0-1.1.9-2 2-2" />
        <path d="M20 2c1.1 0 2 .9 2 2" />
        <path d="M22 8c0 1.1-.9 2-2 2" />
        <path d="M16 10c-1.1 0-2-.9-2-2" />
        <path d="m3 7 3 3 3-3" />
        <path d="M6 10V5c0-1.7 1.3-3 3-3h1" />
        <path d="m21 15-3-3-3 3" />
        <path d="M18 12v5c0 1.7-1.3 3-3 3h-1" />
      </symbol>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --project=local tests/e2e/local/images.spec.ts -g "Replace|oversized"`
Expected: PASS (both new tests, and re-confirm the pre-existing "an oversized image shows the inline error instead of uploading" test — for the *insert* path, unaffected by this task — still passes too).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ImagesModal.svelte client/index.html tests/e2e/local/images.spec.ts
git commit -m "feat: add a per-row Replace action to the Images modal"
```

---

### Task 5: Empty-state copy, docs, and final verification

**Files:**
- Modify: `client/src/components/ImagesModal.svelte`
- Modify: `IMPROVEMENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `package.json`, `package-lock.json`
- Create: `client/public/whats-new/insert-existing-and-replace-image.png`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this task is documentation/polish only.

- [ ] **Step 1: Update the empty-state copy**

In `client/src/components/ImagesModal.svelte`, the empty-state block currently reads:

```svelte
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-images"></use></svg>
        <div class="empty-state-title">No images yet</div>
        <div class="empty-state-desc">Paste, drop, or use the toolbar button to add one.</div>
      </div>
```

Change the description line to:

```svelte
        <div class="empty-state-desc">Upload one above, or paste/drop it into the document.</div>
```

- [ ] **Step 2: Run the full verification suite**

Run, in order, confirming each passes before moving to the next:

```bash
npm run typecheck
npm run format:check
npm test
npm run build
npx playwright test --project=local tests/e2e/local/images.spec.ts
```

If `format:check` fails, run `npm run format` and re-verify.

- [ ] **Step 3: Run the full local e2e suite**

```bash
npx playwright test --project=local
```

Expected: every test passes, confirming nothing else in the app regressed (especially `formatting.spec.ts`, since `insertImage()` changed, and the two pre-existing tests in `images.spec.ts`).

- [ ] **Step 4: Capture a real screenshot showing the feature actually in use**

Start a local preview server (`npm run build && npx vite preview --config client/vite.config.ts --port 5280`), then use Playwright to: open a document, type some content, click the toolbar's Image button to open the modal, upload one image via the new "Upload new image" button so the modal shows a real thumbnail, then take a screenshot of the modal itself (not just the toolbar) at roughly `1200x320` — matching this repo's existing `whats-new` screenshot convention. Save it to `client/public/whats-new/insert-existing-and-replace-image.png`. This screenshot must show the actual modal grid with a thumbnail and the Replace/Delete icons visible, not just the toolbar row — the whole point of this feature is what's inside that modal, and a screenshot that only shows the toolbar would misrepresent it the same way an earlier unrelated feature's first attempt did.

- [ ] **Step 5: Bump the version and update CHANGELOG.md**

This is a user-facing feature — bump the **minor** version. Read the current `version` field in `package.json` first (it changes as other work ships) and bump the minor component by 1, patch reset to 0.

In `package.json` and `package-lock.json` (both the top-level `"version"` field and the nested `"packages": { "": { "version": ... } }` field in the lockfile), set the new version.

Add a new section at the top of `CHANGELOG.md`, right after the file's header paragraph and before the currently-first `## [...]` entry:

```markdown
## [<NEW_VERSION>] - 2026-08-28

### Added

- **Insert an existing image, or replace one in place.** The toolbar's Insert image button now opens the Images modal — click any thumbnail to insert a reference to it, or use the new "Upload new image" button for the original upload flow. Each image also gets a new Replace action: pick a new file and it overwrites that image everywhere it's referenced, without touching the document text or its position.
```

- [ ] **Step 6: Add a What's New entry**

In `client/src/whats-new-entries.ts`, append a new entry to the end of the `WHATS_NEW_ENTRIES` array (before its closing `];`):

```ts
  {
    version: "<NEW_VERSION>",
    title: "Insert Existing Image & Replace",
    description:
      "The Insert image toolbar button now opens a picker of every image already in the document — click one to insert it, or upload a new one from the same place. Each image also gets a Replace action to swap its underlying file in place, everywhere it's referenced.",
    screenshot: "/whats-new/insert-existing-and-replace-image.png",
  },
```

- [ ] **Step 7: Check off the backlog items**

In `IMPROVEMENTS.md`, find these two lines (in the Phase 2 section):

```markdown
- [ ] Add an "insert existing image" picker/autocomplete (browse
      already-uploaded images instead of only inserting new ones).
```

```markdown
- [ ] Replace an existing image's file in place (keep the same
      reference/position, swap the underlying image).
```

Change both checkboxes to `[x]` and append `(Shipped v<NEW_VERSION>.)` to each, matching every other shipped item in that file's own style (e.g. `- [x] Search & replace. (Shipped v1.29.0.)`).

- [ ] **Step 8: Final formatting and typecheck pass**

```bash
npx prettier --check CHANGELOG.md package.json package-lock.json client/src/whats-new-entries.ts IMPROVEMENTS.md client/src/components/ImagesModal.svelte
npm run typecheck
```

Fix any formatting issues with `npm run format` and re-verify.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/ImagesModal.svelte IMPROVEMENTS.md CHANGELOG.md client/src/whats-new-entries.ts package.json package-lock.json client/public/whats-new/insert-existing-and-replace-image.png
git commit -m "docs: version/changelog/whats-new for insert-existing-image and replace-image"
```
