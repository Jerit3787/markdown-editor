# Document Info Edit Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `DocInfoPanel.svelte` into a read-only summary (with a new "Name" row) and a separate `DocEditModal.svelte`, opened via an "Edit" button in Document Info's header, where the document's name, metadata, and citation settings are actually editable.

**Architecture:** Extract two closure-bound rename functions out of `app.ts`'s toolbar-title wiring and expose them on `window.MDE` so both the existing toolbar field and the new modal drive the exact same rename/collision-check path. Move the already-existing editable Metadata/Citations markup out of `DocInfoPanel.svelte` into a new `DocEditModal.svelte` verbatim, then replace what's left in `DocInfoPanel.svelte` with plain read-only rows reusing its existing `.doc-info-row` styling. `DocEditModal` opens `elevated` on top of Document Info via `Modal`'s existing `quickAction`/`elevated` support — no changes needed to `Modal.svelte` itself.

**Tech Stack:** Svelte 5 runes, TypeScript, SCSS, vitest-browser-svelte (`components` project, real Chromium), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-30-doc-info-edit-modal-design.md`

## Global Constraints

- No explicit Save/Cancel button in the edit modal — every field applies live, matching how Metadata/Citations already behave today.
- Created/Edited/Length/Compatibility/Synced-to/Linked-from are not editable and stay exclusively in `DocInfoPanel.svelte` — only Name/Metadata/Citations move to `DocEditModal.svelte`.
- No changes to `Modal.svelte`, to how metadata/citations are stored/synced/exported (`collab.ts`, `repo-sync.ts`), or to `stores/docs.ts`'s existing exports — this is a UI-layer relocation plus one small `app.ts` refactor.
- This is a user-facing change: per `CLAUDE.md` it bumps the **minor** version and needs `package.json`+`package-lock.json`, `CHANGELOG.md`, and `client/src/whats-new-entries.ts` updated together.

---

### Task 1: Extract shared rename logic in `app.ts` and expose it on `window.MDE`

**Files:**
- Modify: `client/src/app.ts` (`initToolbar()`, around lines 587–648, and the `window.MDE` bridge object literal, around line 1157–1167)
- Modify: `client/src/types.ts` (`MDEBridge` interface, around line 176–177)
- Modify: `client/src/components/RenameCollisionModal.svelte` (line 62)

**Interfaces:**
- Produces: `MDEBridge.renameActiveDoc(name: string): void` and `MDEBridge.commitActiveDocRename(previousName: string): void` — consumed by Task 2's `DocEditModal.svelte`.

- [ ] **Step 1: Add the two `MDEBridge` method signatures**

In `client/src/types.ts`, immediately after the existing `onDocRenamed` line:

```ts
  setDocName(id: string, name: string): void;
  onDocRenamed: ((id: string, name: string) => void) | null;
  // Renames the active doc as-you-type: store update + scheduled save +
  // toolbar title sync + page title + collab notification. Same effect as
  // typing into the #docTitle toolbar input — DocEditModal's own Name field
  // (client/src/components/DocEditModal.svelte) calls this on every input
  // so both fields and the doc store stay in sync regardless of which one
  // the user is typing into.
  renameActiveDoc(name: string): void;
  // Commits a rename on blur/Enter: falls back to "Untitled" for an empty
  // value, otherwise checks for a name collision against previousName (the
  // name captured when editing started) and opens RenameCollisionModal via
  // the renameCollision store if one is found. Same effect as blurring the
  // #docTitle toolbar input.
  commitActiveDocRename(previousName: string): void;
```

- [ ] **Step 2: Extract the two functions in `app.ts` and rewire the toolbar listeners to use them**

In `client/src/app.ts`, find `initToolbar()` (currently around line 587). Its body today is:

```ts
  function initToolbar() {
    const docTitleInput = document.getElementById("docTitle") as HTMLInputElement;
    let nameBeforeEdit = "";
    docTitleInput.addEventListener("input", (e) => {
      const doc = getActiveDoc();
      if (!doc) return;
      const name = (e.target as HTMLInputElement).value || "Untitled";
      renameDoc(doc.id, name);
      scheduleSave();
      resizeDocTitle();
      updatePageTitle(name);
      window.MDE.onDocRenamed?.(doc.id, name);
    });
    docTitleInput.addEventListener("focus", () => {
      const doc = getActiveDoc();
      nameBeforeEdit = doc ? doc.name : "";
      if (docTitleInput.value === "Untitled") docTitleInput.value = "";
    });
    docTitleInput.addEventListener("blur", () => {
      if (!docTitleInput.value.trim()) {
        docTitleInput.value = "Untitled";
        resizeDocTitle();
        return;
      }
      const doc = getActiveDoc();
      if (!doc) return;
      const finalName = docTitleInput.value;
      if (finalName === nameBeforeEdit) return;
      const colliding = findCollidingDoc(doc.id, finalName);
      if (colliding) {
        renameCollision.set({ docId: doc.id, pendingName: finalName, previousName: nameBeforeEdit, collidingDocId: colliding.id });
      }
    });
    docTitleInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      docTitleInput.blur();
      cm.focus();
    });
    resizeDocTitle();
  }
```

Replace the whole function with this — `docTitleInput` moves to module-closure scope (declared once, right above `initToolbar`) so the two new top-level functions can reach it without it being passed around:

```ts
  let docTitleInput: HTMLInputElement;

  // Shared by the #docTitle toolbar input (initToolbar, below) and
  // DocEditModal's own Name field via window.MDE — one implementation of
  // "rename the active doc" instead of two.
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

  function initToolbar() {
    docTitleInput = document.getElementById("docTitle") as HTMLInputElement;
    let nameBeforeEdit = "";
    docTitleInput.addEventListener("input", (e) => {
      renameActiveDoc((e.target as HTMLInputElement).value || "Untitled");
    });
    docTitleInput.addEventListener("focus", () => {
      const doc = getActiveDoc();
      nameBeforeEdit = doc ? doc.name : "";
      if (docTitleInput.value === "Untitled") docTitleInput.value = "";
    });
    docTitleInput.addEventListener("blur", () => commitActiveDocRename(nameBeforeEdit));
    docTitleInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      docTitleInput.blur();
      cm.focus();
    });
    resizeDocTitle();
  }
```

Note: `docTitleInput` was previously a `const` local to `initToolbar()`. Search the file for any other reference to a locally-scoped `docTitleInput` inside `initToolbar` to confirm none remain outside the block above (there shouldn't be — `resizeDocTitle()` reads `document.getElementById("docTitle")` itself, not this variable).

- [ ] **Step 3: Add the two methods to the `window.MDE` bridge object literal**

In `client/src/app.ts`, find the bridge object literal's `onDocRenamed: null,` line (currently around line 1167) and add immediately after:

```ts
    onDocRenamed: null,
    renameActiveDoc,
    commitActiveDocRename,
    setDocMetadata(id, metadata) {
```

(`setDocMetadata(id, metadata) {` already exists right after `onDocRenamed: null,` today — this step only inserts the two new lines between them.)

- [ ] **Step 4: Mark `RenameCollisionModal` elevated**

In `client/src/components/RenameCollisionModal.svelte`, change:

```svelte
  <Modal title="Name already in use" labelledBy="renameCollisionTitle" onClose={cancel}>
```

to:

```svelte
  <Modal title="Name already in use" elevated labelledBy="renameCollisionTitle" onClose={cancel}>
```

This is a no-op when nothing else is open (the toolbar-triggered case, unchanged) and is required once a rename can also be triggered from inside the `elevated` `DocEditModal` (Task 2).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 6: Manual verification**

Run `npm run build && npm run dev` (or `npm run dev:client`), open the app, and rename the current document via the toolbar title field (type a new name, press Tab or click away). Confirm the name change persists (reload the page, name is still there) and that renaming to another existing document's name still opens the "Name already in use" dialog with working Cancel/Save as/Replace buttons. This is the existing behavior, now running through the extracted functions — it must be unchanged.

- [ ] **Step 7: Commit**

```bash
git add client/src/app.ts client/src/types.ts client/src/components/RenameCollisionModal.svelte
git commit -m "refactor: extract active-doc rename logic onto the MDE bridge"
```

---

### Task 2: `docEditModalOpen` store + `DocEditModal.svelte`

**Files:**
- Create: `client/src/stores/docEditModalOpen.ts`
- Create: `client/src/components/DocEditModal.svelte`
- Create: `tests/client/src/components/DocEditModal.test.ts`
- Modify: `client/src/main.ts` (mount the new component)
- Modify: `client/index.html` (add the mount point)
- Modify: `client/src/styles/_diff-view.scss` (one new rule, `.doc-edit-name-input`)

**Interfaces:**
- Consumes: `MDEBridge.renameActiveDoc`/`commitActiveDocRename` (Task 1); `MetadataPair` (`../mmd-metadata`), `CitationPrefs`/`BibEntry`/`DEFAULT_CITATION_PREFS` (`../mmd-citations`); `setActiveDocMetadata`/`setActiveDocCitations`/`docsStore`/`activeIdStore`/`getActiveDoc` (`../stores/docs`) — all pre-existing.
- Produces: `docEditModalOpen` writable boolean store, consumed by `DocInfoPanel.svelte`'s Edit button (Task 3).

- [ ] **Step 1: Create the store**

`client/src/stores/docEditModalOpen.ts`:

```ts
import { writable } from "svelte/store";

export const docEditModalOpen = writable(false);
```

- [ ] **Step 2: Write the failing component tests**

`tests/client/src/components/DocEditModal.test.ts` — this takes over every editable-UI test currently in `DocInfoPanel.test.ts` (metadata/citations behavior is unchanged, just relocated) plus new tests for the Name field:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import DocEditModal from "../../../../client/src/components/DocEditModal.svelte";
import { docEditModalOpen } from "../../../../client/src/stores/docEditModalOpen";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  window.MDE = {
    renameActiveDoc: vi.fn(),
    commitActiveDocRename: vi.fn(),
    updatePreview: vi.fn(),
  } as unknown as typeof window.MDE;
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", metadata: [{ key: "Title", value: "Existing" }] }]);
  activeIdStore.set("d1");
  docEditModalOpen.set(true);
});

test("renders the current doc name in the Name field", async () => {
  const screen = await render(DocEditModal);
  await expect.element(screen.getByLabelText("Name")).toHaveValue("Test");
});

test("typing in the Name field calls renameActiveDoc with the new value", async () => {
  const screen = await render(DocEditModal);
  await screen.getByLabelText("Name").fill("Renamed doc");
  expect(window.MDE.renameActiveDoc).toHaveBeenLastCalledWith("Renamed doc");
});

test("blurring the Name field calls commitActiveDocRename with the name captured on focus", async () => {
  const screen = await render(DocEditModal);
  const nameField = screen.getByLabelText("Name");
  await nameField.click();
  await nameField.fill("Renamed doc");
  await nameField.blur();
  expect(window.MDE.commitActiveDocRename).toHaveBeenCalledWith("Test");
});

test("renders existing metadata pairs as rows", async () => {
  const screen = await render(DocEditModal);
  await expect.element(screen.getByPlaceholder("Key").first()).toHaveValue("Title");
  await expect.element(screen.getByPlaceholder("Value").first()).toHaveValue("Existing");
});

test("Add field appends an empty row", async () => {
  const screen = await render(DocEditModal);
  expect((await screen.getByPlaceholder("Key").all()).length).toBe(1);

  await screen.getByRole("button", { name: "Add field" }).click();

  expect((await screen.getByPlaceholder("Key").all()).length).toBe(2);
});

test("editing a row's key updates the underlying doc metadata", async () => {
  const screen = await render(DocEditModal);
  await screen.getByPlaceholder("Key").first().fill("Renamed");

  const { getActiveDoc } = await import("../../../../client/src/stores/docs");
  expect(getActiveDoc()?.metadata).toEqual([{ key: "Renamed", value: "Existing" }]);
});

test("deleting a row removes it", async () => {
  const screen = await render(DocEditModal);
  await screen.getByRole("button", { name: "Remove field" }).click();
  expect((await screen.getByPlaceholder("Key").all()).length).toBe(0);

  const { getActiveDoc } = await import("../../../../client/src/stores/docs");
  expect(getActiveDoc()?.metadata).toEqual([]);
});

test("renders the citation preference controls with correct defaults", async () => {
  const screen = await render(DocEditModal);
  await expect.element(screen.getByRole("button", { name: "Pandoc [@key]" })).toHaveClass(/active/);
  await expect.element(screen.getByRole("button", { name: "Plain text" })).toHaveClass(/active/);
  await expect.element(screen.getByRole("button", { name: "Numbered" })).toHaveClass(/active/);
});

test("Author-year is disabled when bibliography source is plain text", async () => {
  const screen = await render(DocEditModal);
  await expect.element(screen.getByRole("button", { name: "Author-year" })).toBeDisabled();
});

test("switching to Structured enables Author-year and shows entry rows", async () => {
  const screen = await render(DocEditModal);
  await screen.getByRole("button", { name: "Structured" }).click();
  await expect.element(screen.getByRole("button", { name: "Author-year" })).not.toBeDisabled();
  await expect.element(screen.getByPlaceholder("Key")).toBeVisible();
});

test("adding a bibliography entry updates the underlying doc", async () => {
  const screen = await render(DocEditModal);
  await screen.getByRole("button", { name: "Structured" }).click();
  await screen.getByRole("button", { name: "Add entry" }).click();
  const { getActiveDoc } = await import("../../../../client/src/stores/docs");
  expect(getActiveDoc()?.citations?.bibliography).toHaveLength(1);
});

test("a citation preference change refreshes the preview, since it changes rendered output the editor content alone would not", async () => {
  const screen = await render(DocEditModal);
  await screen.getByRole("button", { name: "Structured" }).click();
  expect(window.MDE.updatePreview).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --project=components tests/client/src/components/DocEditModal.test.ts`
Expected: FAIL — `DocEditModal.svelte` does not exist yet.

- [ ] **Step 4: Create `DocEditModal.svelte`**

`client/src/components/DocEditModal.svelte`:

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import { docEditModalOpen } from "../stores/docEditModalOpen";
  import { activeIdStore, getActiveDoc, docsStore, setActiveDocMetadata, setActiveDocCitations } from "../stores/docs";
  import type { MetadataPair } from "../mmd-metadata";
  import { DEFAULT_CITATION_PREFS, type CitationPrefs, type BibEntry } from "../mmd-citations";

  // Same $docsStore.find(...) pattern DocInfoPanel.svelte uses, and for the
  // same reason: recompute when the active doc's own fields change in
  // place, not only when $activeIdStore switches to a different document.
  const doc = $derived($activeIdStore ? $docsStore.find((d) => d.id === $activeIdStore) || getActiveDoc() : undefined);

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

  function close() {
    docEditModalOpen.set(false);
  }

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

  const citationPrefs = $derived(doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS);
  const bibliography = $derived(doc?.citations?.bibliography ?? []);

  function updateCitations(prefs: CitationPrefs, bib: BibEntry[]) {
    if (!doc) return;
    const citations = { prefs, bibliography: bib };
    setActiveDocCitations(citations);
    window.MDE.onDocCitationsChanged?.(doc.id, citations);
    window.MDE.updatePreview?.();
  }

  function setMarkerStyle(markerStyle: CitationPrefs["markerStyle"]) {
    updateCitations({ ...citationPrefs, markerStyle }, bibliography);
  }

  function setBibliographySource(bibliographySource: CitationPrefs["bibliographySource"]) {
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
</script>

{#if $docEditModalOpen && doc}
  <Modal title="Edit document" icon="icon-pencil" elevated labelledBy="docEditTitle" onClose={close}>
    <div class="doc-info-row">
      <label class="doc-info-primary" for="docEditNameInput">Name</label>
      <input
        id="docEditNameInput"
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
  </Modal>
{/if}
```

Note the Name `<input>` uses `onfocus`/`oninput`/`onblur`/`onkeydown` (not `bind:value`) deliberately — `bind:value` would fight with the `value={doc.name}` reactive assignment on every store update, and this component never needs its own local copy of the name since `window.MDE.renameActiveDoc` already writes straight through to the store on every keystroke.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project=components tests/client/src/components/DocEditModal.test.ts`
Expected: PASS, all 13 tests.

- [ ] **Step 6: Add the one new style rule**

In `client/src/styles/_diff-view.scss`, add after the existing `.doc-info-citation-row` rule (around line 271):

```scss
.doc-edit-name-input {
  flex: 1;
  min-width: 0;
  max-width: 260px;
  text-align: right;
}
```

- [ ] **Step 7: Mount the component**

In `client/index.html`, find the Document Info panel mount comment/div (around line 569–571) and add right after it:

```html
    <!-- Document Edit modal — Svelte component, mounted in main.ts; see
     client/src/components/DocEditModal.svelte -->
    <div id="doc-edit-modal-mount"></div>
```

In `client/src/main.ts`, add the import alongside the other component imports:

```ts
import DocEditModal from "./components/DocEditModal.svelte";
```

and the mount call alongside `mount(DocInfoPanel, ...)`:

```ts
mount(DocEditModal, { target: document.getElementById("doc-edit-modal-mount")! });
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 9: Commit**

```bash
git add client/src/stores/docEditModalOpen.ts client/src/components/DocEditModal.svelte tests/client/src/components/DocEditModal.test.ts client/src/main.ts client/index.html client/src/styles/_diff-view.scss
git commit -m "feat: add DocEditModal for editing document name, metadata, and citations"
```

---

### Task 3: `DocInfoPanel.svelte` → read-only, with the Edit button

**Files:**
- Modify: `client/src/components/DocInfoPanel.svelte`
- Modify: `tests/client/src/components/DocInfoPanel.test.ts`
- Modify: `client/src/styles/_diff-view.scss` (one new rule, `.doc-info-edit-btn`)

**Interfaces:**
- Consumes: `docEditModalOpen` (Task 2).

- [ ] **Step 1: Rewrite the failing test file**

Replace the entire contents of `tests/client/src/components/DocInfoPanel.test.ts` (every test in the current file exercises the editable UI that moved to `DocEditModal` in Task 2 — those tests now live in `DocEditModal.test.ts`):

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import DocInfoPanel from "../../../../client/src/components/DocInfoPanel.svelte";
import { docInfoPanelOpen } from "../../../../client/src/stores/docInfoPanel";
import { docEditModalOpen } from "../../../../client/src/stores/docEditModalOpen";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  window.MDE = { formatRelativeTime: () => "just now", updatePreview: vi.fn() } as unknown as typeof window.MDE;
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", metadata: [{ key: "Title", value: "Existing" }] }]);
  activeIdStore.set("d1");
  docInfoPanelOpen.set(true);
  docEditModalOpen.set(false);
});

test("shows the document name as read-only text, not an input", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("Test")).toBeVisible();
  expect((await screen.getByRole("textbox").all()).length).toBe(0);
});

test("shows metadata pairs as read-only rows, not inputs", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("Title")).toBeVisible();
  await expect.element(screen.getByText("Existing")).toBeVisible();
  expect((await screen.getByPlaceholder("Key").all()).length).toBe(0);
});

test("shows a citation preference summary line", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("Pandoc [@key] · Plain text · Numbered")).toBeVisible();
});

test("clicking Edit opens the edit modal", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Edit" }).click();
  expect(get(docEditModalOpen)).toBe(true);
});

test("shows a metadata empty state when there is no metadata", async () => {
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("No metadata")).toBeVisible();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts`
Expected: FAIL — `DocInfoPanel.svelte` still has the old editable markup and no Edit button.

- [ ] **Step 3: Rewrite `DocInfoPanel.svelte`**

Replace the full contents of `client/src/components/DocInfoPanel.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { docInfoPanelOpen } from "../stores/docInfoPanel";
  import { docEditModalOpen } from "../stores/docEditModalOpen";
  import { activeIdStore, activeDocContent, getActiveDoc, docsStore, switchDoc } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
  import { findBacklinks } from "../wikilinks";
  import { fetchRepoDocDates, type RepoDocDates } from "../repo-doc-dates";
  import { scanMarkdownCompatibility, type CompatIssue } from "../markdown-compat";
  import { DEFAULT_CITATION_PREFS } from "../mmd-citations";

  const COMPAT_CATEGORIES = ["app-only", "flavor-specific"] as const;

  // $docsStore.find(...) read directly (not just getActiveDoc(), which
  // unwraps docsStore via the non-reactive get() internally) so this
  // recomputes when the active doc's own fields change in place — e.g.
  // a new image/diagram added — not only when $activeIdStore switches
  // to a different document. Same fix ImagesModal.svelte already
  // applies to this exact trap.
  const doc = $derived($activeIdStore ? $docsStore.find((d) => d.id === $activeIdStore) || getActiveDoc() : undefined);
  const backlinks = $derived(doc ? findBacklinks(doc.name, $docsStore, doc.id) : []);
  const wordCount = $derived.by(() => {
    const text = $activeDocContent.trim();
    return text.length ? text.split(/\s+/).length : 0;
  });
  const charCount = $derived($activeDocContent.length);
  const compatIssues = $derived.by(() => (doc ? scanMarkdownCompatibility($activeDocContent, doc.images, doc.diagrams) : []));
  let compatExpanded = $state(false);

  let repoDates = $state<RepoDocDates | undefined>(undefined);

  // Repo-linked docs show their real commit history instead of local
  // timestamps once it resolves — local timestamps render first (no
  // loading flicker) and get replaced in place if this finds something
  // different. Re-runs whenever the panel switches to a different doc;
  // the abort on cleanup stops a slow fetch for a previously-viewed doc
  // from landing after the panel has already moved on and overwriting
  // the wrong document's display.
  $effect(() => {
    repoDates = undefined;
    if (!doc?.repoPath) return;
    const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId);
    const repoLink = workspace?.repoLink;
    if (!repoLink) return;
    const controller = new AbortController();
    fetchRepoDocDates(repoLink.owner, repoLink.repo, repoLink.branch, doc.repoPath, controller.signal).then((dates) => {
      if (!controller.signal.aborted) repoDates = dates;
    });
    return () => controller.abort();
  });

  const displayCreatedAt = $derived(repoDates?.createdAt ?? doc?.createdAt ?? 0);
  const displayUpdatedAt = $derived(repoDates?.updatedAt ?? doc?.updatedAt ?? 0);

  const citationPrefs = $derived(doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS);
  const bibliography = $derived(doc?.citations?.bibliography ?? []);
  const citationMarkerLabel = $derived(citationPrefs.markerStyle === "pandoc" ? "Pandoc [@key]" : "MultiMarkdown [#key]");
  const citationSourceLabel = $derived(citationPrefs.bibliographySource === "structured" ? "Structured" : "Plain text");
  const citationStyleLabel = $derived(citationPrefs.displayStyle === "author-year" ? "Author-year" : "Numbered");

  function close() {
    docInfoPanelOpen.set(false);
  }

  function openEdit() {
    docEditModalOpen.set(true);
  }

  function jumpTo(id: string) {
    switchDoc(id);
    close();
  }

  function jumpToIssue(issue: CompatIssue) {
    const cm = window.MDE.getEditor();
    cm.dispatch({ selection: { anchor: issue.from, head: issue.to }, scrollIntoView: true });
    cm.focus();
    close();
  }

  // formatRelativeTime (the window.MDE bridge method) is deliberately
  // compact ("Today") for where it's used elsewhere (the Open Recent
  // submenu) — this panel is the one place precise enough to want the
  // full timestamp alongside it.
  function formatFullTimestamp(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $docInfoPanelOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $docInfoPanelOpen && doc}
  <Modal title="Document info" icon="icon-info" labelledBy="docInfoTitle" onClose={close}>
    {#snippet quickAction()}
      <button type="button" class="doc-info-edit-btn" onclick={openEdit}>Edit</button>
    {/snippet}
    <div class="doc-info-row">
      <span class="doc-info-primary">Name</span>
      <span class="doc-info-secondary">{doc.name}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Created</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(displayCreatedAt)} • {formatFullTimestamp(displayCreatedAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Edited</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(displayUpdatedAt)} • {formatFullTimestamp(displayUpdatedAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Length</span>
      <span class="doc-info-secondary">{wordCount} word{wordCount === 1 ? "" : "s"}, {charCount} character{charCount === 1 ? "" : "s"}</span>
    </div>
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
              {category === "app-only" ? "App-only" : "Flavor-specific"}
              <Toggletip icon="icon-info" class="toggletip-inline">
                {category === "app-only" ? "Won't render elsewhere at all." : "Works here and on GitHub, not guaranteed elsewhere."}
              </Toggletip>
            </div>
            {#each categoryIssues as issue}
              <button type="button" class="doc-info-backlink-row" onclick={() => jumpToIssue(issue)}>{issue.label}</button>
            {/each}
          {/if}
        {/each}
      </div>
    {/if}
    <div class="menu-section-label">Metadata</div>
    {#if (doc.metadata ?? []).length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-list"></use></svg>
        <div class="empty-state-title">No metadata</div>
        <div class="empty-state-desc">This document has no metadata fields yet.</div>
      </div>
    {:else}
      <div class="doc-info-metadata-list">
        {#each doc.metadata ?? [] as pair}
          <div class="doc-info-row">
            <span class="doc-info-primary">{pair.key || "—"}</span>
            <span class="doc-info-secondary">{pair.value || "—"}</span>
          </div>
        {/each}
      </div>
    {/if}
    <div class="menu-section-label">Citations</div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Preferences</span>
      <span class="doc-info-secondary">{citationMarkerLabel} · {citationSourceLabel} · {citationStyleLabel}</span>
    </div>
    {#if citationPrefs.bibliographySource === "structured" && bibliography.length > 0}
      <div class="doc-info-metadata-list">
        {#each bibliography as entry}
          <div class="doc-info-row">
            <span class="doc-info-primary">{entry.author || "—"} {entry.year ? `(${entry.year})` : ""}</span>
            <span class="doc-info-secondary">{entry.text || "—"}{entry.key ? ` — [${entry.key}]` : ""}</span>
          </div>
        {/each}
      </div>
    {/if}
    {#if doc.repoPath || doc.gistId}
      <div class="menu-section-label">Synced to</div>
      {#if doc.repoPath}
        {@const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId)}
        {#if workspace?.repoLink}
          <div class="doc-info-row">
            <span class="doc-info-primary">Repo</span>
            <a
              class="doc-info-secondary doc-info-link"
              href={`https://github.com/${workspace.repoLink.owner}/${workspace.repoLink.repo}/blob/${workspace.repoLink.branch}/${doc.repoPath}`}
              target="_blank"
              rel="noopener"
            >
              {workspace.repoLink.owner}/{workspace.repoLink.repo} — {doc.repoPath}
            </a>
          </div>
        {/if}
      {/if}
      {#if doc.gistId}
        <div class="doc-info-row">
          <span class="doc-info-primary">Gist</span>
          <a class="doc-info-secondary doc-info-link" href={`https://gist.github.com/${doc.gistId}`} target="_blank" rel="noopener">
            View on GitHub
          </a>
        </div>
      {/if}
    {/if}
    <div class="menu-section-label">Linked from</div>
    {#if backlinks.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-link"></use></svg>
        <div class="empty-state-title">No backlinks</div>
        <div class="empty-state-desc">No other documents link here yet.</div>
      </div>
    {:else}
      <div class="doc-info-backlinks">
        {#each backlinks as link (link.id)}
          <button type="button" class="doc-info-backlink-row" onclick={() => jumpTo(link.id)}>{link.name}</button>
        {/each}
      </div>
    {/if}
  </Modal>
{/if}
```

- [ ] **Step 4: Add the Edit button style**

In `client/src/styles/_diff-view.scss`, add right after the `.doc-edit-name-input` rule added in Task 2:

```scss
.doc-info-edit-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 500;
  color: var(--accent);
  cursor: pointer;
  flex-shrink: 0;
}
.doc-info-edit-btn:hover,
.doc-info-edit-btn:focus-visible {
  text-decoration: underline;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Run the full component + unit suite**

Run: `npm test`
Expected: PASS — this also re-confirms `DocEditModal.test.ts` from Task 2 still passes and nothing else regressed (`collab.test.ts` in particular, since it touches metadata/citations sync paths that are unchanged).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors — this catches any leftover unused imports in `DocInfoPanel.svelte` (`svelte-check` flags unused imports).

- [ ] **Step 8: Commit**

```bash
git add client/src/components/DocInfoPanel.svelte tests/client/src/components/DocInfoPanel.test.ts client/src/styles/_diff-view.scss
git commit -m "refactor: make DocInfoPanel read-only with an Edit button"
```

---

### Task 4: Playwright e2e coverage

**Files:**
- Create: `tests/e2e/local/doc-info-edit-modal.spec.ts`

**Interfaces:**
- Consumes: the full feature built in Tasks 1–3 (no new production interfaces).

- [ ] **Step 1: Write the e2e test**

Every local e2e spec imports `test`/`expect` from `./support/fixtures` instead of `@playwright/test` directly — that fixture seeds one local document (`id: "e2e-doc-1"`, `name: "E2E Test Doc"`) and one workspace, then navigates to it, exposing the seeded doc id as the `docId` fixture. Document Info is opened via the File menu: `#fileMenuBtn` then `#menuDocInfo` (confirmed current ids in `client/src/components/MenuBar.svelte`). A second document for the collision test is created through the store's own API inside `page.evaluate`, then switched back from — the exact pattern `slash-and-wikilinks.spec.ts`'s `wikilink autocomplete` suite already uses for the same reason (a raw localStorage write doesn't reach the in-memory `docsStore` the app actually reads from).

`tests/e2e/local/doc-info-edit-modal.spec.ts`:

```ts
import { test, expect } from "./support/fixtures";

test("Document Info shows read-only info; Edit opens a modal to rename and edit metadata", async ({ page }) => {
  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  const infoModal = page.locator(".modal-box-v2", { hasText: "Document info" });
  await expect(infoModal).toBeVisible();
  await expect(infoModal.getByRole("textbox")).toHaveCount(0);

  await infoModal.getByRole("button", { name: "Edit" }).click();
  const editModal = page.locator(".modal-box-v2", { hasText: "Edit document" });
  await expect(editModal).toBeVisible();

  const nameInput = page.locator("#docEditNameInput");
  await nameInput.fill("Renamed via edit modal");
  await nameInput.blur();

  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByPlaceholder("Key").first().fill("Author");
  await page.getByPlaceholder("Value").first().fill("Ada");

  await editModal.getByRole("button", { name: "Close" }).click();

  await expect(infoModal).toContainText("Renamed via edit modal");
  await expect(infoModal).toContainText("Author");
  await expect(infoModal).toContainText("Ada");
});

test("renaming to a colliding name from the edit modal opens the collision dialog above it", async ({ page, docId }) => {
  // A second document to collide with, created through the store's own
  // API (not a raw localStorage write) — see slash-and-wikilinks.spec.ts's
  // "wikilink autocomplete" suite for the same pattern and why. createDoc()
  // always switches to the doc it creates, so switch back to the fixture's
  // doc afterward.
  await page.evaluate(async (existingId) => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "e2e-doc-2", name: "Existing Doc" });
    switchDoc(existingId);
  }, docId);

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();

  const nameInput = page.locator("#docEditNameInput");
  await nameInput.fill("Existing Doc");
  await nameInput.blur();

  const collisionModal = page.locator(".modal-box-v2", { hasText: "Name already in use" });
  await expect(collisionModal).toBeVisible();
  await page.getByRole("button", { name: /^Save as/ }).click();
  await expect(collisionModal).not.toBeVisible();
  // The edit modal (elevated, underneath the now-closed collision dialog) is still open and usable.
  await expect(page.locator(".modal-box-v2", { hasText: "Edit document" })).toBeVisible();
});
```

- [ ] **Step 2: Run the new spec**

This sandbox needs a throwaway Playwright config pointing at the pre-installed Chromium — see `CLAUDE.md`'s note on `/opt/pw-browsers/chromium` and this session's own established pattern (a `playwright.local-verify.config.ts` with `executablePath: "/opt/pw-browsers/chromium"`, deleted after use, never committed). Build first, then run:

```bash
npm run build
npx playwright test --config=playwright.local-verify.config.ts tests/e2e/local/doc-info-edit-modal.spec.ts
```

Expected: PASS, both tests. If a selector doesn't match (e.g. `Modal`'s close button's actual accessible name), inspect `client/src/components/Modal.svelte`'s `aria-label="Close"` on its close button — `getByRole("button", { name: "Close" })` should already match that.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/local/doc-info-edit-modal.spec.ts
git commit -m "test: e2e coverage for the Document Info edit modal"
```

---

### Task 5: Version, CHANGELOG, What's New, IMPROVEMENTS

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `IMPROVEMENTS.md` (only if this feature is tracked there — check first; if it isn't listed, skip this file)

**Interfaces:** None — documentation/metadata only.

- [ ] **Step 1: Determine the next version**

Run: `git log --oneline -5 -- package.json` and `cat package.json | grep '"version"'` to find the current version on this branch's base (`master`). Bump the **minor** version per `CLAUDE.md` (this is a user-facing UI change). E.g. if `master` is at `1.37.0`, the new version is `1.38.0`.

- [ ] **Step 2: Bump `package.json` and `package-lock.json`**

In `package.json`, change `"version": "<current>"` to `"version": "<next>"`.

In `package-lock.json`, hand-edit both `"version"` fields (top-level, and `packages[""].version`) to the same `<next>` value — per `CLAUDE.md`, do not run a full `npm install --package-lock-only` regeneration.

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`, add a new section at the top (Keep a Changelog format):

```markdown
## [<next>] - 2026-08-30

### Added
- Document Info now shows a read-only summary (including the document's name), with an Edit button that opens a dedicated modal for renaming the document and editing its metadata and citation settings.
```

- [ ] **Step 4: Add the What's New entry**

In `client/src/whats-new-entries.ts`, append a new entry to `WHATS_NEW_ENTRIES` (oldest-first, so this goes last) following the exact shape of the existing entries in that file — read a couple of the existing entries first to match the `title`/`description`/`version`/`screenshot` field names exactly. Use `version: "<next>"`.

- [ ] **Step 5: Update `IMPROVEMENTS.md` if applicable**

Search `IMPROVEMENTS.md` for any existing line describing this feature (e.g. a Document Info / edit-modal backlog item). If found, mark it done with `(Shipped v<next>.)` matching the existing annotation style for other shipped items. If this feature isn't tracked there, skip this step.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts IMPROVEMENTS.md
git commit -m "chore: bump version to <next> for the Document Info edit modal"
```

---

### Task 6: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: PASS. If it fails, run `npm run format` and re-check.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no errors.

- [ ] **Step 5: Local e2e suite**

Using the same throwaway Playwright config from Task 4:

```bash
npx playwright test --config=playwright.local-verify.config.ts
```

Expected: PASS, including the two new tests from Task 4. Delete `playwright.local-verify.config.ts` afterward — it must never be committed.

- [ ] **Step 6: Manual smoke test**

Run `npm run dev` (after `npm run build`), open a document, open Document Info, confirm: Name/Metadata/Citations show read-only; clicking Edit opens the modal on top; renaming, editing a metadata field, and toggling a citation preference all take effect immediately; closing Edit shows the updated values in Document Info underneath.

- [ ] **Step 7: Report completion**

Summarize what was built and confirm all verification steps passed. Do not proceed to `finishing-a-development-branch` without explicit instruction — that's a separate step the user drives.
