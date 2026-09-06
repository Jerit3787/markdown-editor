# Image Picker Modal — Design Spec

## Goal

Right now four entry points — the toolbar "Image" button, the toolbar
"Manage images" button (`#imagesManagerBtn`), the Insert-menu "Insert
Image..." and "Manage Images..." — all open the **same** `ImagesModal`,
which mixes two jobs in one flat list: adding an image (an "Upload new
image" button) and managing existing ones (per-row Replace / Delete). A
user who just wants to drop in a picture lands in a management surface;
the redundant toolbar button does nothing the "Image" button doesn't.

This splits the two jobs into two modals with clear, separate purposes:

- **Image picker** (the common case — toolbar "Image" button, Insert
  menu "Image..."): a tabbed modal for _getting an image into the
  document_. **Upload** tab (drop a file / choose from device) and
  **Existing** tab (re-insert one already in this document — a pure
  picker). Adding or picking an image inserts it at the cursor and
  closes.
- **Manage Images** (deliberate — Insert menu "Manage Images..." only):
  today's grid, minus insertion — per-image **Replace** and **Delete**,
  the "(not used in this document)" tag, and the per-row size.

The redundant "Manage images" toolbar button is removed.

## Non-goals

- **A cross-document / global image library.** Both modals stay scoped
  to the active document's own image map (`doc.images`), exactly as
  today. Reusing an image across documents still means re-uploading it.
- **Changing the editor's own paste / drop-onto-the-editor behavior.**
  `Editor.svelte`'s `paste`/`drop` DOM handlers, `imageFilesFrom`, and
  the `![… : image too large, 2MB max]()` marker they write are
  untouched — the picker's in-modal drop zone is a _second, additive_
  drop target, not a replacement.
- **Changing the storage model, the 2 MB cap, `imageKey`'s
  filename-based dedup, or the `![alt](key)` → data-URI resolution.**
  All unchanged.
- **Multi-select in the Existing picker.** One click inserts one image
  and closes. (The Upload tab _does_ accept multiple files at once —
  see Data Flow — because a native multi-file pick / multi-file drop is
  a single gesture; re-picking N existing images is N deliberate
  clicks, and closing after the first keeps the "insert one thing"
  model consistent.)
- **A settings toggle for the default tab, or remembering the last-used
  tab across opens.** The default is computed fresh each open (see
  Components), matching the app's existing "reset on open" precedents
  (the mobile sidebar sheet always reopens on "Documents";
  `RenameCollisionModal` etc. never persist transient UI state).
- **Drag-and-drop reordering, alt-text editing, or captions in either
  modal.** Out of scope; nothing today does this.

## Architecture

Two Svelte modal components, each driven by its own boolean store,
mounted independently in `main.ts` (same pattern as every other modal).
Both reuse `Modal.svelte`. The picker is the **first real consumer** of
`Modal.svelte`'s already-built-but-unused `tabs` snippet prop (see
ROADMAP.md's note that it "has no real consumer yet").

```
                          ┌─────────────────────────────┐
 Toolbar "Image" btn ─────▶│                             │
 Insert menu "Image..." ──▶│  ImagePickerModal.svelte    │   imagesModalOpen  (existing store, reused)
                          │  ├─ Upload  tab              │
                          │  └─ Existing tab (picker)    │
                          └─────────────────────────────┘
                                       │ inserts ![alt](key) at cursor, closes

 Insert menu "Manage Images..." ─────▶ ┌──────────────────────────┐
                                      │  ManageImagesModal.svelte │  manageImagesModalOpen  (new store)
                                      │  grid: Replace / Delete /  │
                                      │  size / "(not used)" tag   │
                                      └──────────────────────────┘
```

`ImagesModal.svelte` is **renamed** to `ManageImagesModal.svelte` and
trimmed (drop the insert-on-click and the "Upload new image" button);
`ImagePickerModal.svelte` is **new**. The `imagesModalOpen` store keeps
its name and now drives the picker; a new `manageImagesModalOpen` store
(in the same `stores/imagesModal.ts` file) drives Manage.

### The shared upload primitive

The picker's Upload tab and the editor's paste/drop path both need "read
a `File`, cap-check it, embed it, insert `![alt](key)` at a position".
That's `insertImageWithUpload(file, pos?)` in `Editor.svelte` today.
It gains one optional parameter:

```ts
function insertImageWithUpload(file: File, pos?: number, onError?: (message: string) => void): void
```

- **No `onError`** (editor paste/drop — unchanged): an oversized file
  writes the existing `![name: image too large, 2MB max]()` marker into
  the document, exactly as now.
- **With `onError`** (the picker): an oversized file calls
  `onError("<name> is over the 2 MB limit")` and writes **nothing** —
  the picker surfaces it inline and stays open.

A non-image `File` never reaches `insertImageWithUpload` from either
caller (the editor filters via `imageFilesFrom`; the picker filters on
`file.type.startsWith("image/")` and calls `onError` for the rest), so
no new type-check is added inside `insertImageWithUpload` itself.

`window.MDE.insertImageWithUpload` (the bridge method the picker calls —
it's a Svelte component and reaches the editor through the bridge, same
as `ImagesModal` does today for `insertImageWithUpload` and
`setDocImage`) forwards the third argument.

## Components

### `client/src/stores/imagesModal.ts`

```ts
import { writable } from "svelte/store";
export const imagesModalOpen = writable(false); // drives ImagePickerModal
export const manageImagesModalOpen = writable(false); // drives ManageImagesModal
```

### `client/src/components/ImagePickerModal.svelte` (new)

- Renders `Modal` with `title="Insert image"`, `icon="icon-image"`,
  `wide`, a `tabs` snippet, and `onClose={close}` (`close` sets
  `imagesModalOpen` to `false`).
- **`tabs` snippet:** two `<button>`s — `Upload` and
  `Existing{count > 0 ? ` (${count})` : ""}` — with
  `class:active={activeTab === "upload" | "existing"}`. `Modal.svelte`'s
  `.modal-tabs` CSS already styles these (underline-active). `count` is
  `Object.keys(images).length`.
- **Local state:**
  - `let activeTab = $state<"upload" | "existing">("upload")`
  - `let dragging = $state(false)` — drop-zone hover.
  - `let error = $state<string | null>(null)` — inline upload error.
- **Default-tab effect:** `$effect(() => { if ($imagesModalOpen) { activeTab = hasImages ? "existing" : "upload"; error = null; } })`
  where `hasImages` is `$derived` from `$docsStore`/`$activeIdStore` the
  same way `ImagesModal`'s `images` derived is today (read the active
  doc's `images` map). Recomputes on every open.
- **Upload tab:**
  - A `<button class="image-dropzone" class:dragging>` wrapping the
    prompt text ("Drop images here, or click to choose"), with
    `onclick={() => uploadInputEl.click()}`,
    `ondragover|preventDefault={() => (dragging = true)}`,
    `ondragleave={() => (dragging = false)}`, and
    `ondrop|preventDefault={onDrop}`.
  - Hidden `<input type="file" accept="image/*" multiple bind:this={uploadInputEl} onchange={onPick}>`.
  - `{#if error}<div class="image-upload-error" role="alert">{error}</div>{/if}`
  - `onPick(e)` / `onDrop(e)` → `handleFiles(FileList)`.
- **`handleFiles(files: FileList)`:**
  ```
  error = null;
  const list = [...files];
  const images = list.filter((f) => f.type.startsWith("image/"));
  const rejected = list.filter((f) => !f.type.startsWith("image/"));
  if (rejected.length) { error = `${rejected[0].name} isn't an image`; }
  if (images.length === 0) return; // stay open, error shown
  let hadError = false;
  for (const file of images) {
    window.MDE.insertImageWithUpload(file, undefined, (msg) => { error = msg; hadError = true; });
  }
  if (!hadError) close();
  ```
  (Inserting at `undefined` position → `insertImageWithUpload` uses the
  editor's current selection head, same as the toolbar path today. Each
  successful insert advances the cursor past its own `![alt](key)`, so
  N files land as N refs in sequence — the exact behavior the editor's
  own multi-file `drop` handler already produces.)
- **Existing tab:**
  - `{#if count === 0}` → empty state: icon + "No images in this
    document yet" + "Add one from the Upload tab" (a
    `<button class="link-btn" onclick={() => (activeTab = "upload")}>`).
  - Else a `.image-picker-grid` of `<button class="image-picker-item">`
    per entry, each an `<img src={dataUrl} alt={key}>` with
    `onclick={() => insertExisting(key)}`.
  - `insertExisting(key)`: `window.MDE.getEditor()` → dispatch
    `![${altFromKey(key)}](${key})` at the selection head → `view.focus()`
    → `close()`. (`altFromKey` = `key.replace(/\.[^.]+$/, "") || "image"`,
    lifted verbatim from today's `ImagesModal.insertExisting`.)
- **`onMount`:** Escape-to-close listener, identical to today's
  `ImagesModal`.

### `client/src/components/ManageImagesModal.svelte` (renamed from `ImagesModal.svelte`, trimmed)

Keep from today's `ImagesModal.svelte`:

- The `Modal` shell (`title="Manage images"`, `icon="icon-images"`,
  `wide`, the Toggletip `quickAction` about local storage), driven by
  `$manageImagesModalOpen` instead of `$imagesModalOpen`.
- The `images` derived (unchanged), the empty state, `formatBytes`, the
  `.images-list` / `.image-item` grid with the thumbnail, `.image-name`
  (+ "(not used in this document)" span), `.image-size`.
- **Replace:** `startReplace` / `onReplaceChange` / the hidden
  `#imagesReplaceInput` — unchanged (still `setDocImage(key, dataUrl)` +
  `window.MDE.updatePreview()`, still the 2 MB toast on oversize).
- **Delete:** `removeImage` — unchanged (`confirmAction` →
  `deleteDocImage` → `updatePreview`).
- Escape-to-close.

Remove:

- `insertExisting` and the thumbnail's `onclick`/`role="button"`/
  `tabindex` (the thumbnail is now a plain, non-interactive `<img>`;
  the row is management-only).
- The `.images-modal-upload-row`, its "Upload new image" `<button>`, the
  hidden `#imagesUploadInput`, and `onUploadChange`.
- The `title="Click to insert"` attr on the thumbnail.

### `client/src/components/Toolbar.svelte`

Delete the entire `#imagesManagerBtn` `<button>` and its
`<!-- Wired by app.ts's initImagesManager(), same as before. -->`
comment (lines ~138–139). The "Image" `<button title="Image" onclick={() => run("image")}>`
stays exactly as is.

### `client/src/components/MenuBar.svelte`

- `#menuImage`: label "Insert Image..." → **"Image..."** (still
  `onclick={() => act(() => window.MDE.runCmd("image"))}`).
- `#menuManageImages`: `onclick` changes from
  `window.MDE.openImagesManager()` to `window.MDE.openManageImages()`
  (label "Manage Images..." unchanged).

### `client/src/app.ts`

- Import `manageImagesModalOpen` alongside `imagesModalOpen`.
- Delete `initImagesManager()` and its call in the init sequence (line
  ~95, ~360-363) — the `#imagesManagerBtn` it wired no longer exists.
- Rename the bridge method `openImagesManager` → `openManageImages`, and
  point it at `manageImagesModalOpen.set(true)` (line ~1259-1261).

### `client/src/types.ts`

- `openImagesManager(): void;` → `openManageImages(): void;` in
  `MDEBridge`.

### `client/src/components/Editor.svelte`

- `insertImageWithUpload(file, pos?)` → `insertImageWithUpload(file, pos?, onError?: (message: string) => void)`.
  In the `file.size > MAX_IMAGE_BYTES` branch: `if (onError) { onError(\`${file.name} is over the 2 MB limit\`); return; }` before the existing marker-writing `dispatch`.
- `window.MDE.insertImageWithUpload = insertImageWithUpload;` already
  assigns the function by reference — the new third param rides along.
  Update the `MDEBridge` signature for `insertImageWithUpload` in
  `types.ts` to include the optional third arg.

### `client/index.html`

- `<div id="images-modal-mount"></div>` → **two** mount points:
  `<div id="image-picker-modal-mount"></div>` and
  `<div id="manage-images-modal-mount"></div>`.

### `client/src/main.ts`

- Replace the single `mount(ImagesModal, { target: ... "images-modal-mount" })`
  with `mount(ImagePickerModal, { target: ... "image-picker-modal-mount" })`
  and `mount(ManageImagesModal, { target: ... "manage-images-modal-mount" })`.

## Data Flow

**Insert a new image (Upload tab):**

1. Toolbar "Image" → `runCmd("image")` → `insertImage()` →
   `imagesModalOpen.set(true)`.
2. Picker opens; `$effect` sets `activeTab` = `hasImages ? "existing" : "upload"`.
3. User drops / picks one or more files → `handleFiles`.
4. For each image file: `window.MDE.insertImageWithUpload(file, undefined, onError)`
   → editor reads the file, embeds it (`setDocImage` via the bridge →
   store write + preview refresh), inserts `![alt](key)` at the cursor,
   advances the cursor.
5. No error → `close()` (`imagesModalOpen.set(false)`).

**Insert an already-uploaded image (Existing tab):**

1. Picker open on the Existing tab (auto, because the doc has images).
2. Click a thumbnail → `insertExisting(key)` → editor dispatch
   `![altFromKey(key)](key)` at the cursor → `view.focus()` → `close()`.

**Manage:**

1. Insert menu "Manage Images..." → `window.MDE.openManageImages()` →
   `manageImagesModalOpen.set(true)`.
2. Replace: pick a file → `onReplaceChange` → 2 MB check (toast on fail)
   → `FileReader` → `setDocImage(key, dataUrl)` (overwrites the same
   key, so every `![](key)` in the text now shows the new image) →
   `updatePreview()`.
3. Delete: `confirmAction(...)` → `deleteDocImage(key)` → `updatePreview()`.
   Any `![](key)` left in the text renders as a broken image (unchanged
   from today).

## Error Handling

- **Oversized file, Upload tab:** `insertImageWithUpload`'s `onError`
  fires → picker sets `error` → red inline `role="alert"` line under the
  drop zone → modal stays open, nothing inserted, other files in the
  same batch that _did_ fit are still inserted (the loop continues;
  `close()` is skipped because `hadError`).
- **Non-image file, Upload tab:** filtered out before
  `insertImageWithUpload`; `error` set to `"<first rejected name> isn't
  an image"`. If the batch had at least one real image, those still
  insert and the modal stays open showing the error; if the batch was
  _only_ non-images, nothing inserts and the modal stays open.
- **Oversized file, Manage → Replace:** unchanged — `showToast("Image
  too large (2MB max).", "error")`, the original image untouched.
- **`getActiveDoc()` returns undefined** (no active doc): both modals'
  entry points are already `disabled={!hasActiveDoc}` in `MenuBar`, and
  the toolbar button does nothing useful with no editor — the `images`
  derived already guards (`(doc && doc.images) || {}`), so an empty grid
  / empty Upload tab renders rather than throwing. No new handling.
- **A brand-new doc with zero images:** picker opens on Upload; Existing
  tab shows its empty state with the "Add one from the Upload tab" link.

## Testing

### Component — `tests/client/src/components/ImagePickerModal.test.ts` (new)

Follows `ImagesModal.test.ts`'s pattern (`vitest-browser-svelte`,
`vi.mock` the confirm dialog if needed, set `docsStore`/`activeIdStore`/
`workspacesStore` in `beforeEach`, `window.MDE` stub with `getEditor`
returning a fake view with `state.selection.main.head` + `dispatch`,
`insertImageWithUpload: vi.fn()`, `setDocImage: vi.fn()`).

- Opens on **Upload** when the doc has no images; on **Existing** when
  it has ≥ 1 (toggle `docsStore` between two renders).
- The Existing tab renders one `.image-picker-item` per image; clicking
  one calls the editor dispatch with `![key-stem](key)` and closes
  (`get(imagesModalOpen)` is `false`).
- The Existing tab's empty state shows the "Upload tab" link, and
  clicking it switches `activeTab` to `"upload"`.
- Upload tab: a `change` event on the hidden input with two image
  `File`s calls `window.MDE.insertImageWithUpload` twice and closes.
- Upload tab: an oversized file — `insertImageWithUpload` mock invokes
  its `onError` arg — renders the `role="alert"` line and the modal
  stays open (`get(imagesModalOpen)` still `true`).
- Upload tab: a non-image `File` in the batch renders `"notes.txt isn't
  an image"` and does not call `insertImageWithUpload` for it.
- `dragover` sets `.dragging` on `.image-dropzone`; `dragleave` clears it.

### Component — `tests/client/src/components/ManageImagesModal.test.ts` (rename `ImagesModal.test.ts`)

Keep the existing IMG-12 (delete removes from the map + list) and IMG-13
(per-row size) tests, retargeted at `manageImagesModalOpen` /
`ManageImagesModal`. Add: the thumbnail is **not** a button
(`getByRole("button")` count excludes the thumbnails; clicking a
thumbnail does nothing / no insert), and there is **no** "Upload new
image" button.

### Unit — `tests/client/src/image-key.test.ts`

Unchanged (IMG-14 etc. still hold).

### e2e — `tests/e2e/local/images.spec.ts`

- Update the existing "clicking the toolbar Insert image button opens
  the Images modal" → assert the **picker** opens (title "Insert
  image", the two tabs visible).
- Update "clicking a thumbnail in the Images modal inserts a
  reference" → drive it through the picker's Existing tab.
- Update "Upload new image button inside the modal" → drive it through
  the picker's Upload tab (hidden input `change`, or a real drop —
  `DataTransfer` + `DragEvent` on `.image-dropzone`, per Phase 5's
  IMG-03 approach).
- Update "Replace on a row" / "Replacing with an oversized file" →
  open the **Manage Images** modal (`window.MDE.openManageImages()` or
  the menu item) instead of the toolbar button.
- New: the toolbar has exactly one image button (`button[title="Image"]`
  present, `#imagesManagerBtn` gone).
- New: dropping an oversized image on the picker's drop zone shows the
  inline error and leaves the document text unchanged (no `![… too
  large]()` marker).
- New: the Insert menu has "Image..." and "Manage Images..." (two
  entries, distinct targets).

### Catalog

`docs/TEST-COVERAGE.md` §5: the affected IMG rows (IMG-08, IMG-09,
IMG-10, IMG-11, IMG-12, IMG-13) get their `Test` paths / notes updated
to the new modal names and tab-driven flows; add rows for the new
scenarios (tabs, default tab, in-modal drop zone, inline errors,
one-image-button toolbar). Net: §5 gains ~4 rows, stays fully covered
(the §5 tally in `## Baseline` moves accordingly).

## Versioning

User-facing (the image toolbar/menu is visibly restructured; the
picker is a new modal) → **minor bump to `1.46.0`** in `package.json` +
both `package-lock.json` `version` fields, a new `## [1.46.0] - <date>`
`CHANGELOG.md` section (`### Added` for the picker + tabbed Upload/
Existing, `### Changed` for the toolbar/menu consolidation and the
Manage modal split), **and** a new `WHATS_NEW_ENTRIES` entry appended to
`client/src/whats-new-entries.ts` (oldest-first), `category: "Editing & Formatting"`,
with a `screenshot` field pointing at a real captured asset of the
picker's Upload tab.
