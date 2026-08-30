# Document Info Edit Modal — Design

## Goal

Split the Document Info modal (`DocInfoPanel.svelte`) into a read-only view and
a separate edit surface: Document Info becomes a pure summary (including a new
"Name" row), and an "Edit" button in its header (top-right, via `Modal`'s
existing `quickAction` slot) opens a new `DocEditModal.svelte` — stacked on top
of Document Info — where the document's name, metadata, and citation settings
are actually editable.

Reference: a screenshot from another app showing a "Semester 1" info screen
with an "Edit" text button top-right of the modal header, next to the title.

## Non-goals

- No explicit Save/Cancel/Done buttons in the edit modal — every field applies
  live as you type/toggle, exactly as Metadata and Citations already work
  today. Closing the modal is the only affordance needed.
- No changes to what's editable — Name, Metadata, Citations are the full set
  moved into the edit modal. Created/Edited/Length/Compatibility/Synced
  to/Linked from are not editable today and are not made editable by this
  work; they stay exclusively in the read-only Document Info view.
- No changes to `Modal.svelte` itself — its `quickAction` snippet slot already
  renders top-right of the header (`h2 { flex: 1 }` pushes it there), which is
  exactly what this needs.
- No changes to how metadata/citations are stored, synced (collab.ts,
  repo-sync.ts), or exported — only *where* their editing UI lives changes.

## Current state (for context)

- `DocInfoPanel.svelte` currently renders Created/Edited/Length/Compatibility
  (read-only) followed by **directly editable** Metadata (key/value inputs,
  add/remove) and Citations (marker style / bibliography source / display
  style tab-switches, plus structured bibliography entry inputs) sections,
  then read-only Synced-to/Linked-from sections. There is no "Name" field
  anywhere in this modal.
- Renaming a document today only happens through the `#docTitle` input in the
  main toolbar (`app.ts`'s `initToolbar()`), whose `input`/`blur`/`focus`
  listeners live entirely inside `app.ts`'s private closure: `input` calls
  `renameDoc` (a plain store function from `stores/docs.ts`) plus three
  closure-only side effects (`scheduleSave()`, `resizeDocTitle()`,
  `updatePageTitle()`) and notifies `window.MDE.onDocRenamed`; `blur` falls
  back to "Untitled" for an empty value and, for a real rename, checks for a
  name collision via `findCollidingDoc` (also a plain `stores/docs.ts`
  function) and opens `RenameCollisionModal` via the `renameCollision` store
  if one is found.
- `RenameCollisionModal.svelte` is not currently marked `elevated` on its
  `Modal` — safe today because it can only ever be triggered from the plain
  toolbar, where no other modal is open.

## Architecture

### 1. `DocInfoPanel.svelte` → read-only

- Add a new first row, "Name", showing `doc.name` as plain text (no input).
- Replace the Metadata section's input-based rows with plain read-only
  key/value display. Empty state ("No metadata yet") when `doc.metadata` is
  empty or unset, styled like the existing "No backlinks" empty state
  (`empty-state` pattern), using `icon-list` (confirmed present in the icon
  sprite in `client/index.html`) in place of `icon-link`.
- Replace the Citations tab-switches/bibliography inputs with a read-only
  summary line (e.g. `Pandoc [@key] · Structured · Author-year`, built from
  `citationPrefs`) followed by a read-only bibliography list (author/year/text
  per entry) when `citationPrefs.bibliographySource === "structured"` and
  `bibliography.length > 0`; otherwise no bibliography block. No add/remove
  affordances.
- Everything else (Created/Edited/Length row markup, Compatibility
  expand/jump-to-issue, Synced-to links, Linked-from backlink navigation)
  stays exactly as today — those are already read-only/navigation-only.
- Add the "Edit" button via `Modal`'s `quickAction` snippet:
  ```svelte
  {#snippet quickAction()}
    <button type="button" class="doc-info-edit-btn" onclick={openEdit}>Edit</button>
  {/snippet}
  ```
  `openEdit()` sets a new `docEditModalOpen` store to `true`. Styled as a
  plain accent-colored text button (new `.doc-info-edit-btn` rule alongside
  the other `doc-info-*` styles in `_diff-view.scss`), matching the
  screenshot's plain-text "Edit" link.
- All the `update*`/`add*`/`remove*` functions currently in `DocInfoPanel.svelte`
  (`updateMetadata`, `addMetadataField`, `updateMetadataField`,
  `removeMetadataField`, `updateCitations`, `setMarkerStyle`,
  `setBibliographySource`, `setDisplayStyle`, `addBibEntry`, `updateBibEntry`,
  `removeBibEntry`) move to `DocEditModal.svelte` verbatim — `DocInfoPanel`
  keeps only the derived read values it still displays (`citationPrefs`,
  `bibliography`, plus the existing `doc`/`backlinks`/`wordCount`/`charCount`/
  `compatIssues`/`repoDates` derivations).

### 2. New `docEditModalOpen` store

`client/src/stores/docEditModalOpen.ts`, identical shape to the existing
`docInfoPanelOpen.ts`:

```ts
import { writable } from "svelte/store";

export const docEditModalOpen = writable(false);
```

### 3. New `DocEditModal.svelte`

Mounted in `main.ts` the same way every other modal is (`mount(DocEditModal, {
target: document.getElementById("doc-edit-modal-mount")! })`), with a matching
`<div id="doc-edit-modal-mount">` added to `client/index.html`.

Structure:

```svelte
{#if $docEditModalOpen && doc}
  <Modal title="Edit document" icon="icon-pencil" elevated labelledBy="docEditTitle" onClose={close}>
    <div class="doc-info-row">
      <span class="doc-info-primary">Name</span>
      <input
        type="text"
        class="doc-edit-name-input"
        value={doc.name}
        onfocus={onNameFocus}
        oninput={onNameInput}
        onblur={onNameBlur}
        onkeydown={onNameKeydown}
      />
    </div>
    <div class="menu-section-label">Metadata</div>
    <!-- moved verbatim from DocInfoPanel.svelte -->
    ...
    <div class="menu-section-label">Citations</div>
    <!-- moved verbatim from DocInfoPanel.svelte -->
    ...
  </Modal>
{/if}
```

`doc` is derived the same way `DocInfoPanel.svelte` already does (the
`$docsStore.find(...)` pattern, not a bare `getActiveDoc()`, for the same
in-place-update reactivity reason documented on that line today).

Closing sets `docEditModalOpen` to `false`; it does not touch
`docInfoPanelOpen`, so closing Edit always drops back to an already-updated
Document Info underneath.

### 4. Name field wiring — extracting shared rename logic in `app.ts`

Two functions are extracted from the existing toolbar `input`/`blur`
listener bodies in `app.ts`'s `initToolbar()`, made closure-level named
functions, and exposed on `window.MDE` so `DocEditModal.svelte` can drive the
exact same rename path the toolbar uses — no duplicated logic, and the
existing collision-detection / debounced-save / page-title-update behavior is
inherited for free:

```ts
// Shared by the #docTitle toolbar input and DocEditModal's own Name field —
// see MDEBridge.renameActiveDoc/commitActiveDocRename in types.ts.
function renameActiveDoc(name: string) {
  const doc = getActiveDoc();
  if (!doc) return;
  renameDoc(doc.id, name);
  scheduleSave();
  if (docTitleInput.value !== name) docTitleInput.value = name;
  resizeDocTitle();
  updatePageTitle(name);
  window.MDE.onDocRenamed?.(doc.id, name);
}

function commitActiveDocRename(previousName: string) {
  if (!docTitleInput.value.trim()) {
    docTitleInput.value = "Untitled";
    resizeDocTitle();
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;
  const finalName = docTitleInput.value;
  if (finalName === previousName) return;
  const colliding = findCollidingDoc(doc.id, finalName);
  if (colliding) {
    renameCollision.set({ docId: doc.id, pendingName: finalName, previousName, collidingDocId: colliding.id });
  }
}
```

The toolbar's own listeners become thin wrappers so there is exactly one
implementation of each:

```ts
docTitleInput.addEventListener("input", (e) => {
  renameActiveDoc((e.target as HTMLInputElement).value || "Untitled");
});
docTitleInput.addEventListener("focus", () => {
  const doc = getActiveDoc();
  nameBeforeEdit = doc ? doc.name : "";
  if (docTitleInput.value === "Untitled") docTitleInput.value = "";
});
docTitleInput.addEventListener("blur", () => commitActiveDocRename(nameBeforeEdit));
```

(`nameBeforeEdit` and the focus-clears-"Untitled" behavior stay toolbar-local;
`DocEditModal` reimplements that same small bit of UI convenience locally with
its own component state, since it's plain presentation logic with no
closure dependency.)

`window.MDE` additions (`types.ts`):

```ts
// Renames the active doc as-you-type (store update + save/page-title/collab
// notification) — same effect as typing into the #docTitle toolbar input.
renameActiveDoc(name: string): void;
// Commits a rename on blur/Enter: falls back to "Untitled" for an empty
// value, otherwise checks for a name collision against previousName (the
// name captured when editing started) and opens RenameCollisionModal if one
// is found. Same effect as blurring the #docTitle toolbar input.
commitActiveDocRename(previousName: string): void;
```

`DocEditModal.svelte`'s Name field:

```ts
let nameBeforeEdit = "";

function onNameFocus(e: FocusEvent) {
  nameBeforeEdit = doc?.name ?? "";
  const input = e.target as HTMLInputElement;
  if (input.value === "Untitled") input.value = "";
}
function onNameInput(e: Event) {
  window.MDE.renameActiveDoc((e.target as HTMLInputElement).value || "Untitled");
}
function onNameBlur() {
  window.MDE.commitActiveDocRename(nameBeforeEdit);
}
function onNameKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
}
```

### 5. `RenameCollisionModal.svelte` needs `elevated`

Today it can only ever open while no other modal is on screen, so it doesn't
need `elevated`. Once a rename can be triggered from inside `DocEditModal`
(itself `elevated` at z-index 330), the collision dialog must render on top of
that too — there's only one `elevated` tier (330) above the base tier (320),
so marking `RenameCollisionModal`'s `Modal` as `elevated` is correct and
sufficient in both the toolbar-triggered and edit-modal-triggered cases (it's
a no-op visually when nothing else is open).

## Error handling / edge cases

- `doc` becoming `undefined` mid-edit (e.g. the doc was deleted from another
  tab while Edit was open): both `DocInfoPanel` and `DocEditModal` already
  guard their whole template on `{#if ... && doc}`, so the modal simply
  disappears, same as Document Info does today.
- Renaming to an empty string: handled identically to the toolbar today (falls
  back to "Untitled" on blur).
- Renaming to a colliding name: `RenameCollisionModal` opens elevated above
  `DocEditModal`; resolving it (Replace/Save-as-suffixed/Cancel) uses its
  existing `commitName` helper, which dispatches a synthetic `input` event on
  `#docTitle` — this now flows through `renameActiveDoc` same as any other
  rename, so `DocEditModal`'s own Name field (bound to `doc.name`, not local
  state) picks up the resolved name automatically on the next render.

## Testing

- `tests/client/src/components/DocInfoPanel.test.ts` (existing, if present —
  otherwise new): renders read-only Name/Metadata/Citations, "Edit" button
  present, clicking it sets `docEditModalOpen` to `true`.
- `tests/client/src/components/DocEditModal.test.ts` (new): renaming updates
  the doc store and reflects in `doc.name`; adding/editing/removing a
  metadata field and a bibliography entry apply live; changing citation
  marker/source/display style applies live.
- Playwright e2e (`tests/e2e/local/`): open Document Info → click Edit →
  rename the document, edit a metadata field → close Edit → verify Document
  Info shows the new name and metadata read-only. A second test drives a
  collision: rename to an existing doc's name from inside Edit, verify
  `RenameCollisionModal` appears above Edit and resolving it applies the
  final name back into both modals.
- No changes needed to existing `history.ts`/metadata/citations/collab tests
  — the underlying store functions (`renameDoc`, `setActiveDocMetadata`,
  `setActiveDocCitations`, `findCollidingDoc`) are unchanged, only their UI
  entry point moves.

## Versioning

This is a user-facing UI change, so per `CLAUDE.md` it bumps the **minor**
version and needs `package.json`+`package-lock.json`, a new `CHANGELOG.md`
section, and a new `client/src/whats-new-entries.ts` entry.
