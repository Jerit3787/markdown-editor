# Insert Existing Image & Replace Image — Design Spec

**IMPROVEMENTS.md Phase 2 items** (two, combined into one design since they share the same UI surface): "Add an 'insert existing image' picker/autocomplete (browse already-uploaded images instead of only inserting new ones)" and "Replace an existing image's file in place (keep the same reference/position, swap the underlying image)."

Today, the toolbar's "Insert image" button (`insertImage()` in `formatting-commands.ts`) only ever opens the OS file picker for a brand-new upload — there is no way to reuse an image already embedded in the document, and no way to swap a wrong/outdated image for a new one without deleting the old reference and re-inserting a fresh one (which also changes its position and requires re-typing alt text).

## Goal

- The existing "Insert image" toolbar button/menu entry/Command Palette entry opens the existing Images modal (`ImagesModal.svelte`, already used by "Manage images") instead of jumping straight to the OS file picker.
- Inside that modal, clicking a thumbnail inserts `![alt](key)` at the cursor and closes the modal.
- An "Upload new image" button inside the modal preserves today's original upload flow.
- Each image row gets a new "Replace" action: pick a new file, and it overwrites the *same key* in place — every existing `![alt](key)` reference in the document automatically shows the new image, with no text edited and no position/reference change.

## Non-goals (deferred)

- **No shared-document (`imagesMap`) support.** `ImagesModal.svelte` already only reads/writes `doc.images` (the local-document image store) — it has no branch for a shared document's Yjs `imagesMap` today. This spec doesn't add one; insert-existing and replace are both scoped to local (never-shared) documents only, matching the modal's existing scope exactly. A collaborator using a shared document still only gets the "upload new" path, same as before this change.
- **No autocomplete/search box** inside the modal. The backlog item's phrasing ("picker/autocomplete") is satisfied by a clickable grid of thumbnails — the modal's list is not expected to grow large enough (these are documents' own embedded images, not a shared media library) to need text filtering.
- **No new toolbar button.** The existing "Insert image" button's behavior changes; "Manage images" stays as its own unchanged entry point into the same modal.
- **No collab-sync push for replace.** `deleteDocImage` (the modal's existing delete action) never notifies collaborators of the removal either — `replaceImage` follows the same already-established precedent and only writes to local storage, not `window.MDE.onImageAdded`. Extending this modal to push edits to collaborators is out of scope for both existing and new actions here.

## Components

### `client/src/formatting-commands.ts` (modify)

```ts
export function insertImage() {
  imagesModalOpen.set(true);
}
```

Replaces the current `document.getElementById("imageFileInput").click()` body. New import: `imagesModalOpen` from `./stores/imagesModal`. This is the only change needed to redirect both existing entry points — the toolbar's Image button (`Toolbar.svelte`) and the Command Palette's "Insert image" entry (`CommandPalette.svelte`) — both already call `runCmd("image")` → `insertImage()`, so neither needs its own change. (There is no separate "Insert image" menu entry in `MenuBar.svelte` today.)

### `client/src/components/ImagesModal.svelte` (modify)

Three additions, all scoped to this one file:

1. **Click-to-insert.** The `<img>` element in each row gets `onclick={() => insertExisting(img.key)}` plus `role="button"`/`tabindex`/cursor-pointer styling for affordance:

   ```ts
   function insertExisting(key: string) {
     const view = window.MDE.getEditor();
     const alt = key.replace(/\.[^.]+$/, "") || "image";
     view.dispatch({ changes: { from: view.state.selection.main.head, insert: `![${alt}](${key})` } });
     view.focus();
     close();
   }
   ```

   The alt-text derivation (`key.replace(/\.[^.]+$/, "") || "image"`) mirrors `Editor.svelte`'s existing `altTextFromFilename()` exactly — duplicated here rather than exported, since `Editor.svelte`'s `<script>` block is instance-scoped (not a `<script module>` block), so nothing in it is importable by another component; a two-line pure function isn't worth promoting into a new shared module for this alone.

2. **"Upload new image" button**, rendered once near the top of the modal body (visible in both the empty state and the populated list — uploading your first image should work from inside this modal too, not just via drag/drop or the pre-existing hidden `#imageFileInput`). Uses its own local hidden `<input type="file" accept="image/*" hidden bind:this={uploadInputEl} onchange={...}>` — **not** the global `#imageFileInput` in `index.html` (which `app.ts`'s `initImageUploads()` already wires unconditionally to `window.MDE.insertImageWithUpload?.(file)`, a self-contained pipeline this spec doesn't need to touch or duplicate control flow around):

   ```ts
   function onUploadChange(e: Event) {
     const file = (e.target as HTMLInputElement).files?.[0];
     (e.target as HTMLInputElement).value = "";
     if (!file) return;
     close();
     window.MDE.insertImageWithUpload?.(file);
   }
   ```

   Closing the modal immediately (before the async file read completes) matches today's existing feel: choosing a file in the OS picker already returns you straight to the editor, where a placeholder (`![Encoding filename…]()`) appears immediately and resolves once the read finishes — see `Editor.svelte`'s existing `insertImageWithUpload`, reused here unmodified via the bridge.

3. **Per-row "Replace" button**, next to the existing Delete button. One shared local hidden `<input type="file" accept="image/*" hidden bind:this={replaceInputEl} onchange={onReplaceChange}>` plus one `let replaceKey = $state<string | null>(null)` to remember which row triggered it:

   ```ts
   const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // matches Editor.svelte's own limit

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

   `setDocImage` (imported from `../stores/docs`, alongside the file's existing `deleteDocImage` import — not the `window.MDE.setDocImage` bridge method, which is `Editor.svelte`'s own upload-pipeline entry point and always pairs with `onImageAdded` for collab propagation this spec explicitly excludes, see Non-goals) does a per-key merge, so calling it with an existing key overwrites just that entry — every `![alt](key)` reference in the document text is untouched and simply resolves to the new `dataUrl` the next time the preview (or a fresh `img` tag) reads it. `window.MDE.updatePreview()` afterward matches the exact pattern the file's existing `removeImage()` already uses.

   The modal stays open after a successful replace (unlike insert, which has one job and is done) — a user replacing several outdated images in one session shouldn't have to reopen the modal each time. The thumbnail updates immediately since `images` is a `$derived.by` over `$docsStore`, which `setDocImage`'s `updateDoc()` call already triggers a re-render through.

4. **Empty-state copy** updated to mention the new upload button instead of only "the toolbar button": `"Upload one below, or paste/drop it into the document."`

### Testing

- `tests/e2e/local/images.spec.ts` (extend): seed two images via `window.MDE.insertImageWithUpload!` (existing helper), open the modal via the toolbar's Image button, click a thumbnail, assert the new `![alt](key)` reference lands at the cursor and the modal closes. Click Replace on a row, supply a new file, assert the *same key* now maps to the new data URL in `doc.images` and the document text is byte-identical to before (no reference changed). Assert clicking "Upload new image" inside the modal closes it and inserts a placeholder, matching the existing upload-and-insert test's own assertions.
- No new unit-test file — `insertExisting`'s alt-text derivation and `onReplaceChange`'s size-limit branch are simple enough to cover directly through the e2e tests above (matching how `Editor.svelte`'s equivalent logic is only covered by `images.spec.ts` today, not a separate unit test).
