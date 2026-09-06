# Image Picker Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the one overloaded `ImagesModal` into a tabbed **Image Picker** (Upload / Existing, opened by the toolbar "Image" button and the Insert menu) and a separate management-only **Manage Images** modal (Insert menu only), and remove the redundant "Manage images" toolbar button.

**Architecture:** Two Svelte modal components, each driven by its own boolean store in `stores/imagesModal.ts`, each mounted independently in `main.ts` (the app's existing modal pattern). Both reuse `Modal.svelte`; the picker is the first real consumer of `Modal.svelte`'s existing `tabs` snippet prop. The picker's Upload tab and the editor's own paste/drop path share one primitive, `insertImageWithUpload`, which gains an optional `onError` callback so the picker can surface an oversized-file error inline instead of writing the editor's `![… too large]()` marker.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vite, CodeMirror 6, Vitest (`unit` jsdom + `components` vitest-browser-svelte in headless Chromium), Playwright (`local` project).

**Spec:** `docs/superpowers/specs/2026-09-07-image-picker-modal-design.md`

## Global Constraints

- Both modals stay scoped to the **active document's own `doc.images` map** — no cross-document/global image library.
- The editor's own `paste`/`drop` DOM handlers, `imageFilesFrom`, and the `![name: image too large, 2MB max]()` marker are **unchanged** — the picker's drop zone is an additive second drop target.
- Storage model, the **2 MB cap** (`MAX_IMAGE_BYTES = 2 * 1024 * 1024`), `imageKey`'s filename dedup, and `![alt](key)` → data-URI resolution are all unchanged.
- No settings toggle for the default tab, no remembering the last-used tab — the default is recomputed on every open.
- Existing picker = pure picker: one click inserts one image and closes. No multi-select, no delete/replace in the picker. Delete/Replace live only in Manage Images.
- User-facing change → **minor version bump to `1.46.0`**: `package.json` + both `package-lock.json` `"version"` fields (lines ~3 and ~9, hand-edited), a new `## [1.46.0] - 2026-09-07` section in `CHANGELOG.md`, **and** a new `WHATS_NEW_ENTRIES` entry (oldest-first) in `client/src/whats-new-entries.ts` with `category: "Editing & Formatting"` and a **real captured** `screenshot` asset in `client/public/whats-new/`.
- Do the version bump + whats-new entry **last** (Task 5), immediately before opening the PR — not while implementing.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. No `Claude-Session` trailer.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `client/src/stores/imagesModal.ts` | The two boolean open-state stores | Add `manageImagesModalOpen` |
| `client/src/components/Editor.svelte` | Owns `insertImageWithUpload` (the shared upload primitive) | Add optional `onError` param |
| `client/src/types.ts` | `MDEBridge` contract | `insertImageWithUpload` 3rd arg; `openImagesManager` → `openManageImages` |
| `client/src/components/ImagePickerModal.svelte` | **New.** Tabbed Upload/Existing picker; inserts `![alt](key)` and closes | Create |
| `client/src/components/ManageImagesModal.svelte` | Renamed from `ImagesModal.svelte`; management-only grid (Replace/Delete/size/unused tag) | Rename + retarget store + trim |
| `client/src/components/Toolbar.svelte` | Editor toolbar | Remove `#imagesManagerBtn` |
| `client/src/components/MenuBar.svelte` | App menu bar | `#menuImage` label → "Image..."; `#menuManageImages` → `openManageImages()` |
| `client/src/app.ts` | Bridge + init sequence | Drop `initImagesManager()`; rename bridge `openImagesManager` → `openManageImages`; import `manageImagesModalOpen` |
| `client/index.html` | Static mount points | `images-modal-mount` → `image-picker-modal-mount` + `manage-images-modal-mount` |
| `client/src/main.ts` | Mounts all modals | Mount both new components |
| `client/src/styles/_utilities.scss` | Modal/list styles | Add `.image-dropzone`, `.image-upload-error`, `.image-picker-grid`, `.image-picker-item`, `.image-picker-link`; drop the now-dead `.images-modal-upload-row`; `.image-item img` cursor |
| `tests/client/src/components/ImagePickerModal.test.ts` | **New.** Picker component tests | Create |
| `tests/client/src/components/ManageImagesModal.test.ts` | Renamed from `ImagesModal.test.ts`; retargeted + 2 new assertions | Rename + edit |
| `tests/e2e/local/images.spec.ts` | Image e2e flows | Rewrite the 5 modal-driven tests + 3 new cases |
| `docs/TEST-COVERAGE.md` | §5 catalog | Update IMG rows + add new scenario rows |
| `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/` | Release notes | v1.46.0 |

---

## Task 1: `insertImageWithUpload` gains an `onError` callback

**Files:**
- Modify: `client/src/components/Editor.svelte` (function `insertImageWithUpload`, ~line 242)
- Modify: `client/src/types.ts` (line ~254)
- Test: `tests/e2e/local/images.spec.ts` (new test, appended near the other `insertImageWithUpload` tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `window.MDE.insertImageWithUpload(file: File, pos?: number, onError?: (message: string) => void): void`. When `onError` is supplied and the file exceeds `MAX_IMAGE_BYTES`, `onError` is called with `` `${file.name} is over the 2 MB limit` `` and **nothing** is written to the document. When `onError` is omitted, behavior is exactly as today (writes the `![name: image too large, 2MB max]()` marker).

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/local/images.spec.ts`:

```ts
test("insertImageWithUpload with an onError callback reports oversize and writes no marker", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const before = window.MDE.getEditor().state.doc.toString();
    const bigFile = new File([new Uint8Array(3 * 1024 * 1024)], "over.png", { type: "image/png" });
    let reported: string | null = null;
    window.MDE.insertImageWithUpload!(bigFile, undefined, (msg: string) => {
      reported = msg;
    });
    // give any (unexpected) async dispatch a tick
    await new Promise((r) => setTimeout(r, 50));
    return { reported, after: window.MDE.getEditor().state.doc.toString(), before };
  });
  expect(result.reported).toBe("over.png is over the 2 MB limit");
  expect(result.after).toBe(result.before);
  expect(result.after).not.toContain("image too large");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run build && npx playwright test tests/e2e/local/images.spec.ts -g "onError callback reports oversize" --config playwright.config.ts`
Expected: FAIL — `insertImageWithUpload` currently ignores a 3rd arg, so it writes the `image too large` marker and `result.reported` is `null`.

(If the sandbox Playwright browser is missing, apply the `client/dist` / `executablePath` workaround from `CLAUDE.md`, run, then revert it.)

- [ ] **Step 3: Implement**

In `client/src/components/Editor.svelte`, change the signature and the oversize branch:

```ts
  function insertImageWithUpload(file: File, pos?: number, onError?: (message: string) => void) {
    const from = pos ?? view!.state.selection.main.head;
    if (file.size > MAX_IMAGE_BYTES) {
      if (onError) {
        onError(`${file.name} is over the 2 MB limit`);
        return;
      }
      view!.dispatch({ changes: { from, insert: `![${file.name}: image too large, 2MB max]()` } });
      return;
    }
```

(The rest of the function body is unchanged. `window.MDE.insertImageWithUpload = insertImageWithUpload;` at line ~578 already assigns by reference, so the new param rides along.)

- [ ] **Step 4: Update the bridge type**

In `client/src/types.ts`, line ~254:

```ts
  insertImageWithUpload?(file: File, pos?: number, onError?: (message: string) => void): void;
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx playwright test tests/e2e/local/images.spec.ts -g "onError callback reports oversize"`
Expected: PASS. Also run the whole file to confirm no regression: `npx playwright test tests/e2e/local/images.spec.ts`.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add client/src/components/Editor.svelte client/src/types.ts tests/e2e/local/images.spec.ts
git commit -m "feat(editor): let insertImageWithUpload report oversize via an onError callback

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Split into `ImagePickerModal` + `ManageImagesModal`, rewire toolbar/menu/mounts

This is one atomic restructure — the app does not build/run correctly at a partial point (two modals on one store, or a store with no consumer). Ship it as a unit; its test cycle is the two component test files.

**Files:**
- Modify: `client/src/stores/imagesModal.ts`
- Create: `client/src/components/ImagePickerModal.svelte`
- Rename: `client/src/components/ImagesModal.svelte` → `client/src/components/ManageImagesModal.svelte` (retarget store + title only — **trim is Task 3**)
- Modify: `client/index.html` (mount points)
- Modify: `client/src/main.ts` (imports + mounts)
- Modify: `client/src/app.ts` (drop `initImagesManager` + its call; rename bridge method; import the new store)
- Modify: `client/src/components/MenuBar.svelte` (label + bridge call)
- Modify: `client/src/components/Toolbar.svelte` (remove `#imagesManagerBtn`)
- Modify: `client/src/types.ts` (`openImagesManager` → `openManageImages`)
- Modify: `client/src/styles/_utilities.scss` (add picker styles)
- Create: `tests/client/src/components/ImagePickerModal.test.ts`
- Rename: `tests/client/src/components/ImagesModal.test.ts` → `tests/client/src/components/ManageImagesModal.test.ts` (retarget store/import only — new assertions land in Task 3)

**Interfaces:**
- Consumes: `window.MDE.insertImageWithUpload(file, pos?, onError?)` (Task 1), `window.MDE.getEditor()`, `window.MDE.setDocImage`, `window.MDE.updatePreview` (bridge, existing); `imagesModalOpen` (existing store, now drives the picker); `docsStore`, `activeIdStore`, `getActiveDoc`, `deleteDocImage`, `setDocImage` (stores/docs, existing).
- Produces:
  - `stores/imagesModal.ts` exports `imagesModalOpen` (picker, unchanged name) **and** `manageImagesModalOpen` (new), both `Writable<boolean>`.
  - `window.MDE.openManageImages(): void` — sets `manageImagesModalOpen` to `true` (replaces `openImagesManager`).
  - `ImagePickerModal.svelte` — mounted at `#image-picker-modal-mount`; renders when `$imagesModalOpen`.
  - `ManageImagesModal.svelte` — mounted at `#manage-images-modal-mount`; renders when `$manageImagesModalOpen`.

- [ ] **Step 1: Write the failing picker test**

Create `tests/client/src/components/ImagePickerModal.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

import ImagePickerModal from "../../../../client/src/components/ImagePickerModal.svelte";
import { imagesModalOpen } from "../../../../client/src/stores/imagesModal";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { activeWorkspaceIdStore, workspacesStore } from "../../../../client/src/stores/workspaces";

const SMALL = "data:image/png;base64,AAAA";

let dispatched: string[];
let insertImageWithUpload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dispatched = [];
  insertImageWithUpload = vi.fn();
  window.MDE = {
    getEditor: () => ({
      state: { selection: { main: { head: 0 } }, doc: { toString: () => "" } },
      dispatch: (tr: { changes: { insert: string } }) => dispatched.push(tr.changes.insert),
      focus: vi.fn(),
    }),
    insertImageWithUpload,
    setDocImage: vi.fn(),
    updatePreview: vi.fn(),
  } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images: {} }]);
  activeIdStore.set("d1");
  imagesModalOpen.set(true);
});

test("opens on the Upload tab when the document has no images", async () => {
  const screen = await render(ImagePickerModal);
  await expect.element(screen.getByText("Drop images here, or click to choose")).toBeVisible();
});

test("opens on the Existing tab when the document already has images", async () => {
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images: { "a.png": SMALL } }]);
  const screen = await render(ImagePickerModal);
  await expect.poll(() => screen.container.querySelectorAll(".image-picker-item").length).toBe(1);
});

test("clicking an existing thumbnail inserts ![stem](key) and closes", async () => {
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images: { "a.png": SMALL } }]);
  const screen = await render(ImagePickerModal);
  await screen.container.querySelector(".image-picker-item")!.click();
  expect(dispatched).toEqual(["![a](a.png)"]);
  expect(get(imagesModalOpen)).toBe(false);
});

test("the Existing empty state links back to the Upload tab", async () => {
  const screen = await render(ImagePickerModal);
  // force onto Existing
  await screen.getByRole("tab", { name: /Existing/ }).click();
  await screen.getByRole("button", { name: "Add one from the Upload tab" }).click();
  await expect.element(screen.getByText("Drop images here, or click to choose")).toBeVisible();
});

test("picking two image files calls insertImageWithUpload twice and closes", async () => {
  const screen = await render(ImagePickerModal);
  const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1])], "one.png", { type: "image/png" }));
  dt.items.add(new File([new Uint8Array([2])], "two.png", { type: "image/png" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.poll(() => insertImageWithUpload.mock.calls.length).toBe(2);
  expect(get(imagesModalOpen)).toBe(false);
});

test("an oversized file keeps the modal open and shows the inline alert", async () => {
  insertImageWithUpload.mockImplementation((_f: File, _p: unknown, onError: (m: string) => void) => onError("big.png is over the 2 MB limit"));
  const screen = await render(ImagePickerModal);
  const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1])], "big.png", { type: "image/png" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("over the 2 MB limit");
  expect(get(imagesModalOpen)).toBe(true);
});

test("a non-image file is rejected inline and never reaches insertImageWithUpload", async () => {
  const screen = await render(ImagePickerModal);
  const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;
  const dt = new DataTransfer();
  dt.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("notes.txt isn't an image");
  expect(insertImageWithUpload).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run --project=components tests/client/src/components/ImagePickerModal.test.ts`
Expected: FAIL — `ImagePickerModal.svelte` does not exist (import error).

- [ ] **Step 3: Add the `manageImagesModalOpen` store**

Replace `client/src/stores/imagesModal.ts` with:

```ts
import { writable } from "svelte/store";

// Drives ImagePickerModal — the toolbar "Image" button and the Insert
// menu "Image..." item both open this.
export const imagesModalOpen = writable(false);

// Drives ManageImagesModal — the Insert menu "Manage Images..." item only.
export const manageImagesModalOpen = writable(false);
```

- [ ] **Step 4: Create `client/src/components/ImagePickerModal.svelte`**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { imagesModalOpen } from "../stores/imagesModal";
  import { docsStore, activeIdStore, getActiveDoc } from "../stores/docs";

  // Same reactive-lookup reasoning as ManageImagesModal's `images` derived:
  // read $docsStore/$activeIdStore directly so the grid refreshes when the
  // active doc's image map changes, with getActiveDoc()'s workspace-scoped
  // fallback for the rare "id not in the list yet" tick.
  const images = $derived.by(() => {
    if (!$imagesModalOpen) return [];
    const doc = $docsStore.find((d) => d.id === $activeIdStore) || getActiveDoc();
    const imgs = (doc && doc.images) || {};
    return Object.entries(imgs).map(([key, dataUrl]) => ({ key, dataUrl }));
  });
  const count = $derived(images.length);

  let activeTab = $state<"upload" | "existing">("upload");
  let dragging = $state(false);
  let error = $state<string | null>(null);
  let uploadInputEl: HTMLInputElement | undefined = $state();

  // Reset transient UI on every open; default to Existing only when the
  // doc already has images (matches the app's "reset on open" precedents).
  $effect(() => {
    if ($imagesModalOpen) {
      activeTab = count > 0 ? "existing" : "upload";
      error = null;
      dragging = false;
    }
  });

  function close() {
    imagesModalOpen.set(false);
  }

  function altFromKey(key: string) {
    return key.replace(/\.[^.]+$/, "") || "image";
  }

  function insertExisting(key: string) {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: `![${altFromKey(key)}](${key})` } });
    view.focus();
    close();
  }

  function handleFiles(files: FileList | null | undefined) {
    error = null;
    const list = Array.from(files || []);
    const imageFiles = list.filter((f) => f.type.startsWith("image/"));
    const rejected = list.filter((f) => !f.type.startsWith("image/"));
    if (rejected.length) error = `${rejected[0].name} isn't an image`;
    if (imageFiles.length === 0) return;
    let hadError = false;
    for (const file of imageFiles) {
      window.MDE.insertImageWithUpload?.(file, undefined, (msg) => {
        error = msg;
        hadError = true;
      });
    }
    if (!hadError) close();
  }

  function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    handleFiles(input.files);
    input.value = "";
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $imagesModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $imagesModalOpen}
  <Modal title="Insert image" icon="icon-image" wide labelledBy="imagePickerModalTitle" onClose={close}>
    {#snippet tabs()}
      <button type="button" role="tab" aria-selected={activeTab === "upload"} class:active={activeTab === "upload"} onclick={() => (activeTab = "upload")}>
        Upload
      </button>
      <button type="button" role="tab" aria-selected={activeTab === "existing"} class:active={activeTab === "existing"} onclick={() => (activeTab = "existing")}>
        Existing{count > 0 ? ` (${count})` : ""}
      </button>
    {/snippet}

    {#if activeTab === "upload"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <button
        type="button"
        class="image-dropzone"
        class:dragging
        onclick={() => uploadInputEl?.click()}
        ondragover={(e) => {
          e.preventDefault();
          dragging = true;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={(e) => {
          e.preventDefault();
          dragging = false;
          handleFiles(e.dataTransfer?.files);
        }}
      >
        <svg class="icon"><use href="#icon-upload"></use></svg>
        <span>Drop images here, or click to choose</span>
      </button>
      <input type="file" accept="image/*" multiple hidden bind:this={uploadInputEl} onchange={onPick} />
      {#if error}<div class="image-upload-error" role="alert">{error}</div>{/if}
    {:else if count === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-images"></use></svg>
        <div class="empty-state-title">No images in this document yet</div>
        <div class="empty-state-desc">
          <button type="button" class="image-picker-link" onclick={() => (activeTab = "upload")}>Add one from the Upload tab</button>
        </div>
      </div>
    {:else}
      <div class="image-picker-grid">
        {#each images as img (img.key)}
          <button type="button" class="image-picker-item" title={img.key} onclick={() => insertExisting(img.key)}>
            <img src={img.dataUrl} alt={img.key} />
          </button>
        {/each}
      </div>
    {/if}
  </Modal>
{/if}
```

- [ ] **Step 5: Rename `ImagesModal.svelte` → `ManageImagesModal.svelte` and retarget its store (NO trim yet)**

```bash
git mv client/src/components/ImagesModal.svelte client/src/components/ManageImagesModal.svelte
```

In `ManageImagesModal.svelte`, make exactly these edits (leave the upload row, `insertExisting`, and the thumbnail `onclick` in place for now — Task 3 removes them):

1. Line 5: `import { imagesModalOpen } from "../stores/imagesModal";` → `import { manageImagesModalOpen } from "../stores/imagesModal";`
2. Line 25 (inside `images` derived): `if (!$imagesModalOpen) return [];` → `if (!$manageImagesModalOpen) return [];`
3. Line 37 (`close`): `imagesModalOpen.set(false);` → `manageImagesModalOpen.set(false);`
4. Line 99 (Escape handler): `if (e.key === "Escape" && $imagesModalOpen) close();` → `if (e.key === "Escape" && $manageImagesModalOpen) close();`
5. Line 106: `{#if $imagesModalOpen}` → `{#if $manageImagesModalOpen}`
6. Line 107: `title="Images in this document"` → `title="Manage images"`, `labelledBy="imagesModalTitle"` → `labelledBy="manageImagesModalTitle"`

- [ ] **Step 6: Two mount points in `client/index.html`**

Replace (line ~623-626):

```html
    <!-- Images manager — Svelte component, mounted in main.ts; see
     client/src/components/ImagesModal.svelte -->
    <div id="images-modal-mount"></div>
```

with:

```html
    <!-- Image picker + Manage images — Svelte components, mounted in main.ts;
     see client/src/components/ImagePickerModal.svelte and ManageImagesModal.svelte -->
    <div id="image-picker-modal-mount"></div>
    <div id="manage-images-modal-mount"></div>
```

- [ ] **Step 7: Mount both in `client/src/main.ts`**

Line ~41: `import ImagesModal from "./components/ImagesModal.svelte";` →

```ts
import ImagePickerModal from "./components/ImagePickerModal.svelte";
import ManageImagesModal from "./components/ManageImagesModal.svelte";
```

Line ~77: `mount(ImagesModal, { target: document.getElementById("images-modal-mount")! });` →

```ts
mount(ImagePickerModal, { target: document.getElementById("image-picker-modal-mount")! });
mount(ManageImagesModal, { target: document.getElementById("manage-images-modal-mount")! });
```

- [ ] **Step 8: `client/src/app.ts` — drop `initImagesManager`, rename the bridge method**

1. Line ~38: `import { imagesModalOpen } from "./stores/imagesModal";` → `import { imagesModalOpen, manageImagesModalOpen } from "./stores/imagesModal";`
2. Line ~95: delete the `initImagesManager();` line from the init sequence.
3. Lines ~359-364: delete the whole `// ---------- Images manager ----------` block:
   ```ts
     // ---------- Images manager ----------
     function initImagesManager() {
       document.getElementById("imagesManagerBtn")?.addEventListener("click", () => {
         imagesModalOpen.set(true);
       });
     }
   ```
4. Lines ~1259-1261: rename the bridge method:
   ```ts
       openManageImages() {
         manageImagesModalOpen.set(true);
       },
   ```
   (`imagesModalOpen` is still imported — `insertImage()` in `formatting-commands.ts` uses it for the picker. Leave that import.)

- [ ] **Step 9: `client/src/types.ts` — rename the bridge method**

Line ~284: `openImagesManager(): void;` → `openManageImages(): void;`

- [ ] **Step 10: `client/src/components/MenuBar.svelte`**

Line ~250: `Insert Image...` → `Image...` (text only; the `onclick={() => act(() => window.MDE.runCmd("image"))}` is unchanged).
Line ~251: `window.MDE.openImagesManager()` → `window.MDE.openManageImages()` (label "Manage Images..." unchanged).

- [ ] **Step 11: `client/src/components/Toolbar.svelte` — remove the redundant button**

Delete lines ~138-139:

```html
    <!-- Wired by app.ts's initImagesManager(), same as before. -->
    <button id="imagesManagerBtn" type="button" title="Manage images"><svg class="icon"><use href="#icon-images"></use></svg></button>
```

(The `<button title="Image" onclick={() => run("image")}>` immediately above stays.)

- [ ] **Step 12: Picker styles in `client/src/styles/_utilities.scss`**

Replace `.images-modal-upload-row { margin-bottom: 10px; }` (lines ~336-338) with:

```scss
.image-dropzone {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  border: 2px dashed var(--border);
  border-radius: 10px;
  background: var(--bg-alt);
  color: var(--text-dim);
  font-size: 13.5px;
  cursor: pointer;

  .icon {
    width: 24px;
    height: 24px;
  }

  &:hover,
  &.dragging {
    border-color: var(--accent);
    color: var(--text);
  }
}
.image-upload-error {
  margin-top: 10px;
  color: var(--danger);
  font-size: 12.5px;
}
.image-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
  max-height: 50vh;
  overflow-y: auto;
}
.image-picker-item {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-alt);
  cursor: pointer;
  aspect-ratio: 1;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  &:hover {
    border-color: var(--accent);
  }
}
.image-picker-link {
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
```

- [ ] **Step 13: Rename the Manage test file, retarget its store import only**

```bash
git mv tests/client/src/components/ImagesModal.test.ts tests/client/src/components/ManageImagesModal.test.ts
```

In `ManageImagesModal.test.ts`:
- `import ImagesModal from "../../../../client/src/components/ImagesModal.svelte";` → `import ManageImagesModal from "../../../../client/src/components/ManageImagesModal.svelte";`
- `import { imagesModalOpen } from "../../../../client/src/stores/imagesModal";` → `import { manageImagesModalOpen } from "../../../../client/src/stores/imagesModal";`
- `imagesModalOpen.set(true);` in `beforeEach` → `manageImagesModalOpen.set(true);`
- Both `render(ImagesModal)` calls → `render(ManageImagesModal)`

(The two existing tests — IMG-12 delete, IMG-13 size — stay green. New assertions come in Task 3.)

- [ ] **Step 14: Run both component test files**

Run: `npx vitest run --project=components tests/client/src/components/ImagePickerModal.test.ts tests/client/src/components/ManageImagesModal.test.ts`
Expected: PASS (all picker tests + the 2 retargeted Manage tests). If `getByRole("tab", …)` doesn't match, adjust the picker markup's `role="tab"` / the test selector so they agree — the tabs render inside `Modal.svelte`'s `role="tablist"` wrapper.

- [ ] **Step 15: Typecheck, full unit suite, format**

Run: `npm run typecheck && npx vitest run && npm run format`
Expected: all green. `svelte-check` must show 0 errors (pre-existing `toolbar.svelte` `$state` warnings are fine).

- [ ] **Step 16: Manual smoke via a built client**

Run: `npm run build && npm run dev` — then in the browser: toolbar "Image" opens the tabbed picker; Insert menu shows "Image..." and "Manage Images..."; the old "Manage images" toolbar button is gone; Manage Images still lists/replaces/deletes.

- [ ] **Step 17: Commit**

```bash
git add client/src/stores/imagesModal.ts client/src/components/ImagePickerModal.svelte client/src/components/ManageImagesModal.svelte client/index.html client/src/main.ts client/src/app.ts client/src/types.ts client/src/components/MenuBar.svelte client/src/components/Toolbar.svelte client/src/styles/_utilities.scss tests/client/src/components/ImagePickerModal.test.ts tests/client/src/components/ManageImagesModal.test.ts
git commit -m "feat(images): split the images modal into a tabbed picker and a manage modal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Trim `ManageImagesModal` to management-only

**Files:**
- Modify: `client/src/components/ManageImagesModal.svelte`
- Modify: `tests/client/src/components/ManageImagesModal.test.ts` (2 new assertions)
- Modify: `client/src/styles/_utilities.scss` (`.image-item img` cursor)

**Interfaces:**
- Consumes: unchanged.
- Produces: `ManageImagesModal.svelte` no longer inserts on thumbnail click and no longer has an "Upload new image" button. Replace / Delete / size / "(not used in this document)" tag remain.

- [ ] **Step 1: Write the failing assertions**

Append to `tests/client/src/components/ManageImagesModal.test.ts`:

```ts
test("the thumbnail is not interactive — no insert-on-click", async () => {
  const screen = await render(ManageImagesModal);
  const thumb = screen.container.querySelector(".image-item-thumb") as HTMLElement;
  expect(thumb.tagName).toBe("IMG");
  expect(thumb.getAttribute("role")).toBeNull();
  expect(thumb).not.toHaveAttribute("tabindex");
  // clicking it does nothing (no dispatch, modal stays open)
  thumb.click();
  expect(get(manageImagesModalOpen)).toBe(true);
});

test("there is no 'Upload new image' button", async () => {
  const screen = await render(ManageImagesModal);
  expect(screen.container.querySelector("#imagesUploadInput")).toBeNull();
  const labels = Array.from(screen.container.querySelectorAll("button")).map((b) => b.textContent?.trim());
  expect(labels.some((l) => /upload new image/i.test(l || ""))).toBe(false);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run --project=components tests/client/src/components/ManageImagesModal.test.ts`
Expected: FAIL — thumbnail still has `role="button"`/`tabindex`; the upload button/input still exist.

- [ ] **Step 3: Trim the component**

In `client/src/components/ManageImagesModal.svelte`:

1. Delete the `insertExisting` function (lines ~47-53).
2. Delete `let uploadInputEl` (line ~55) and the `onUploadChange` function (lines ~57-63).
3. In the template, replace the upload row block:
   ```html
       <div class="images-modal-upload-row">
         <button type="button" class="secondary-btn" onclick={() => uploadInputEl?.click()}>
           <svg class="icon"><use href="#icon-upload"></use></svg> Upload new image
         </button>
         <input id="imagesUploadInput" type="file" accept="image/*" hidden bind:this={uploadInputEl} onchange={onUploadChange} />
         <input id="imagesReplaceInput" type="file" accept="image/*" hidden bind:this={replaceInputEl} onchange={onReplaceChange} />
       </div>
   ```
   with just the replace input (kept — it's the hidden target for the per-row Replace button):
   ```html
       <input id="imagesReplaceInput" type="file" accept="image/*" hidden bind:this={replaceInputEl} onchange={onReplaceChange} />
   ```
4. Replace the interactive thumbnail:
   ```html
             <!-- svelte-ignore a11y_click_events_have_key_events -->
             <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
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
   with a plain image:
   ```html
             <img src={img.dataUrl} alt="" class="image-item-thumb" />
   ```
5. In the empty state, update the copy so it no longer points at an "above" button:
   `<div class="empty-state-desc">Upload one above, or paste/drop it into the document.</div>` → `<div class="empty-state-desc">Add images from the Image picker, or paste/drop them into the document.</div>`

- [ ] **Step 4: Thumbnail cursor**

In `client/src/styles/_utilities.scss`, in the `.image-item img { … }` block (~line 355-363), remove `cursor: pointer;` (the thumbnail is no longer clickable).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project=components tests/client/src/components/ManageImagesModal.test.ts`
Expected: PASS (4 tests: IMG-12, IMG-13, thumbnail-not-interactive, no-upload-button).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add client/src/components/ManageImagesModal.svelte tests/client/src/components/ManageImagesModal.test.ts client/src/styles/_utilities.scss
git commit -m "refactor(images): trim ManageImagesModal to management-only

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Rewrite the image e2e flows

**Files:**
- Modify: `tests/e2e/local/images.spec.ts`

**Interfaces:**
- Consumes: `window.MDE.openManageImages()` (Task 2), the picker DOM (`.image-dropzone`, `.image-picker-item`, `.image-picker-grid`, tabs), `button[title="Image"]`.
- Produces: green `local` Playwright project.

- [ ] **Step 1: Update the 5 modal-driven tests**

In `tests/e2e/local/images.spec.ts`:

1. **"clicking the toolbar Insert image button opens the Images modal"** → rename to `"the toolbar Image button opens the tabbed picker"`:
   ```ts
   test("the toolbar Image button opens the tabbed picker", async ({ page }) => {
     await page.click('button[title="Image"]');
     await expect(page.getByRole("dialog")).toBeVisible();
     await expect(page.getByRole("tab", { name: "Upload" })).toBeVisible();
     await expect(page.getByRole("tab", { name: /Existing/ })).toBeVisible();
   });
   ```

2. **"clicking a thumbnail in the Images modal inserts a reference and closes the modal"** → drive through the picker's Existing tab:
   ```ts
   test("picking an existing image from the picker inserts a reference and closes", async ({ page }) => {
     await page.evaluate(async () => {
       const bytes = Uint8Array.from(atob("iVBORw0KGgo="), (c) => c.charCodeAt(0));
       await window.MDE.insertImageWithUpload!(new File([bytes], "pixel.png", { type: "image/png" }));
     });
     await page.click('button[title="Image"]');
     await page.getByRole("tab", { name: /Existing/ }).click();
     await page.click(".image-picker-item");
     await expect(page.getByRole("dialog")).not.toBeVisible();
     await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("(pixel.png)");
   });
   ```

3. **"Upload new image button inside the modal inserts a new image and closes the modal"** → drive through the picker's Upload tab hidden input:
   ```ts
   test("uploading via the picker's Upload tab inserts a new image and closes", async ({ page }) => {
     await page.click('button[title="Image"]');
     await page.getByRole("tab", { name: "Upload" }).click();
     await page.locator('#image-picker-modal-mount input[type="file"]').setInputFiles({
       name: "fresh.png",
       mimeType: "image/png",
       buffer: Buffer.from(PIXEL_PNG_BASE64, "base64"),
     });
     await expect(page.getByRole("dialog")).not.toBeVisible();
     await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("mde:docs") || "[]")[0]?.images ?? {}))).toContain("fresh.png");
   });
   ```

4. **"Replace on a row replaces the image data"** and **"Replacing with an oversized file shows an error…"** → open Manage Images instead of the toolbar button:
   Replace `await page.click('button[title="Image"]'); await expect(page.getByText("Images in this document")).toBeVisible();` in both with:
   ```ts
   await page.evaluate(() => window.MDE.openManageImages());
   await expect(page.getByText("Manage images")).toBeVisible();
   ```
   (The `#imagesReplaceInput` selector and the rest of each test body are unchanged.)

- [ ] **Step 2: Add 3 new tests**

```ts
test("the toolbar has exactly one image button and no separate manage button", async ({ page }) => {
  await expect(page.locator('button[title="Image"]')).toHaveCount(1);
  await expect(page.locator("#imagesManagerBtn")).toHaveCount(0);
});

test("the Insert menu has both 'Image...' and 'Manage Images...'", async ({ page }) => {
  await page.click("#insertMenuBtn");
  await expect(page.locator("#menuImage")).toHaveText(/Image\.\.\./);
  await expect(page.locator("#menuManageImages")).toHaveText(/Manage Images\.\.\./);
});

test("dropping an oversized image on the picker drop zone shows an inline error and writes no marker", async ({ page }) => {
  const before = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());
  await page.click('button[title="Image"]');
  await page.getByRole("tab", { name: "Upload" }).click();
  await page.evaluate(() => {
    const dz = document.querySelector(".image-dropzone")!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(3 * 1024 * 1024)], "huge.png", { type: "image/png" }));
    dz.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.getByRole("alert")).toContainText("over the 2 MB limit");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe(before);
});
```

(If `PIXEL_PNG_BASE64` / `PIXEL_BYTES` constants aren't already in the file's top scope, reuse whatever the existing tests use — check the top of the file. The `atob("iVBORw0KGgo=")` inline form above avoids the dependency.)

- [ ] **Step 3: Run the file**

Run: `npm run build && npx playwright test tests/e2e/local/images.spec.ts`
Expected: all green. Re-check the drop-zone test isn't flaky (run it 3×).

- [ ] **Step 4: Run the whole local e2e suite**

Run: `npm run test:e2e:local`
Expected: green. If another spec referenced the old `"Images in this document"` title or `#imagesManagerBtn`, fix it here.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/local/images.spec.ts
git commit -m "test(images): drive the e2e image flows through the picker and manage modals

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Catalog, version bump, changelog, whats-new entry + screenshot

**Files:**
- Modify: `docs/TEST-COVERAGE.md` (§5 + Baseline tally)
- Modify: `package.json`, `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Create: `client/public/whats-new/image-picker.png`

- [ ] **Step 1: Update the coverage catalog**

In `docs/TEST-COVERAGE.md` §5 (Images):
- Repoint the `Test` column for IMG-08, IMG-09, IMG-10, IMG-11 to `tests/client/src/components/ImagePickerModal.test.ts` / the rewritten `tests/e2e/local/images.spec.ts` flows; IMG-12, IMG-13 to `tests/client/src/components/ManageImagesModal.test.ts`.
- Add rows: picker default tab (Upload vs Existing), in-modal drop zone upload, in-modal inline oversize error, non-image rejection, one-image-button toolbar, Insert-menu split. Mark them `covered` (e2e/component).
- Bump the §5 line in `## Baseline` by the net new rows (≈ +5 covered) and update the overall tally line the same way.

- [ ] **Step 2: Version bump**

`package.json` line 4: `"version": "1.45.12"` → `"version": "1.46.0"`.
`package-lock.json` line 3 and line 9: `"version": "1.45.12"` → `"version": "1.46.0"` (hand-edit both, no `npm install`).

Run: `grep -n '"version"' package.json package-lock.json | head -3` — confirm all three read `1.46.0`.

- [ ] **Step 3: CHANGELOG**

Add at the top of `CHANGELOG.md` (above `## [1.45.12]`):

```markdown
## [1.46.0] - 2026-09-07

### Added

- **A tabbed image picker.** The toolbar "Image" button and the Insert menu's "Image..." now open a dedicated picker with an **Upload** tab (drop files onto the modal or pick from your device, several at once) and an **Existing** tab (re-insert an image already in the document with one click). Oversized files are flagged inline in the modal instead of leaving a "too large" marker in your text.

### Changed

- **The image toolbar/menu is consolidated.** The redundant "Manage images" toolbar button is removed — image management (Replace, Delete, storage size, "not used in this document") now lives in its own **Manage Images...** modal, reached from the Insert menu. The toolbar keeps a single "Image" button.
```

- [ ] **Step 4: Capture the screenshot**

Write a throwaway Playwright script (or reuse an existing screenshot helper under `tests/`) that: builds the client, serves it, creates a doc, clicks `button[title="Image"]`, switches to the Upload tab, and screenshots the modal (`page.getByRole("dialog").screenshot({ path: "client/public/whats-new/image-picker.png" })`). The image must be a real capture — never a placeholder.

Run it, confirm `client/public/whats-new/image-picker.png` exists and looks right (`SendUserFile` it for review).

- [ ] **Step 5: whats-new entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts` (last, oldest-first order):

```ts
  {
    version: "1.46.0",
    title: "Tabbed Image Picker",
    description:
      "Inserting an image now opens a dedicated picker: an Upload tab to drop files onto the modal or pick from your device, and an Existing tab to re-insert an image already in the document with one click. Oversized files are flagged in the modal instead of leaving a marker in your text. Replace and delete moved to their own Manage Images modal in the Insert menu.",
    screenshot: "/whats-new/image-picker.png",
    category: "Editing & Formatting",
  },
```

- [ ] **Step 6: Verify the whats-new wiring**

Run: `npm run dev:client` and open the What's New dialog — the new entry renders with its image, no dev warning about a version mismatch (`__APP_VERSION__` is now `1.46.0`).

- [ ] **Step 7: Full verification**

Run: `npm test && npm run typecheck && npm run format:check && npm run build`
Expected: all green.

- [ ] **Step 8: Commit + PR**

```bash
git add docs/TEST-COVERAGE.md package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/image-picker.png
git commit -m "chore(release): image picker modal — v1.46.0

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push -u origin feat/image-picker-modal
```

Open a PR against `master` titled `feat(images): tabbed image picker + separate Manage Images modal`, body summarizing the split, the shared `onError` primitive, the test additions, and the v1.46.0 bump, ending with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Wait for CI green (`test`, `build`, `typecheck`, `format:check`, `e2e`, `e2e-collab`) before merging with a merge commit.

---

## Self-Review

**Spec coverage:**
- Two modals, two stores, mounted independently — Tasks 2 (create/mount) ✓
- `Modal.svelte` `tabs` snippet first consumer — Task 2 Step 4 ✓
- `insertImageWithUpload(file, pos?, onError?)`, marker when no `onError`, callback + no write when present — Task 1 ✓
- Picker: default tab recomputed per open, `dragging`, inline `error`, Upload drop zone + hidden multiple input, `handleFiles` loop, Existing pure-picker grid + empty state link, `altFromKey`, Escape-to-close — Task 2 Step 4 ✓
- Manage: keep Replace/Delete/size/unused tag + Toggletip + Escape; remove insert-on-click, upload row, "Click to insert" — Tasks 2 (retarget) + 3 (trim) ✓
- Toolbar `#imagesManagerBtn` removed — Task 2 Step 11 ✓
- MenuBar label + `openManageImages` — Task 2 Step 10 ✓
- `app.ts` drop `initImagesManager`, rename bridge method — Task 2 Step 8 ✓
- `types.ts` both signature changes — Tasks 1 Step 4 + 2 Step 9 ✓
- `index.html` two mounts, `main.ts` two mounts — Task 2 Steps 6-7 ✓
- All test buckets (ImagePickerModal component, ManageImagesModal component rename + 2 assertions, image-key unit untouched, images.spec rewrite + new cases, catalog) — Tasks 2, 3, 4, 5 ✓
- Versioning: package.json + lock ×2, CHANGELOG `### Added`/`### Changed`, whats-new entry + real screenshot, `category: "Editing & Formatting"` — Task 5 ✓

**Placeholder scan:** No "TBD"/"handle appropriately"; every code step has literal content. Screenshot step explicitly forbids a placeholder asset.

**Type consistency:** `manageImagesModalOpen` (store), `openManageImages` (bridge method + `types.ts`), `insertImageWithUpload(file, pos?, onError?)` used identically in Editor, `types.ts`, picker, and tests. `altFromKey` (picker) is a local copy of the same regex `ManageImagesModal` used as `insertExisting`'s `alt` (which Task 3 deletes). `.image-picker-item` / `.image-dropzone` / `.image-upload-error` / `.image-picker-grid` / `.image-picker-link` class names match between the component (Task 2 Step 4), the CSS (Task 2 Step 12), and the e2e selectors (Task 4).

**Known intermediate state:** none — after every task the app builds, all suites pass, and every entry point works. Task 2 is large but atomic by necessity (one store can't drive two modals mid-swap).
