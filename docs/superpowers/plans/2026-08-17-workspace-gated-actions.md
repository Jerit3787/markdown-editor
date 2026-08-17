# Workspace-Gated Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh install starts with zero workspaces (matching VS Code's "no folder open"), and every action that assumes a workspace or an active document exists is explicitly gated instead of silently self-healing or being left unguarded.

**Architecture:** `workspaces.ts` stops seeding a default workspace on first run. Four entry points that create a document or need a workspace to attach to (`createNewDoc`, `openLocalFile`, `openGistPicker`, `openRepoLinkModal`) each gain an explicit `workspacesStore.length === 0` guard, showing an error toast instead of proceeding. `docs.ts`'s existing self-heal fallback in `createDoc()` stays as a defensive last resort (already tested, no code change needed — comment-only update). `MenuBar.svelte` gains one `hasActiveDoc` derived value, bound as `disabled` on every File-menu item below "Open Recent" (except the GitHub Repo submenu) and the entire Edit menu. `collab.ts`'s `joinSharedLink` adopts a shared link directly (no dialog) when the receiver has zero workspaces.

**Tech Stack:** TypeScript, Svelte 5, Vitest.

## Global Constraints

- Tier 2 guard message, verbatim, for all four entry points: `showToast("Create a workspace first", "error")`.
- Existing users' current workspace(s) are never touched — this only changes what a `localStorage` with no `mde:workspaces` key ever set produces.
- `docs.ts`'s `createDoc()` self-heal fallback is not removed — it stays as a documented, defensive-only safety net (already covered by an existing test: `createDoc self-heals by creating a workspace on demand when none exist`).
- `DocList.svelte`, `WorkspaceSwitcher.svelte`, and the wikilink auto-create path need no code changes — all three are already safely gated by construction (per-row actions can't be triggered on a row that doesn't exist; wikilink auto-create requires an already-rendered preview pane).

---

### Task 1: No default workspace on fresh installs

**Files:**
- Modify: `client/src/stores/workspaces.ts`
- Modify: `client/src/stores/workspaces.test.ts`

**Interfaces:**
- Produces: `workspacesStore`'s initial value is `[]` (not a seeded workspace) when `mde:workspaces` was never set.

- [ ] **Step 1: Update the failing test**

In `client/src/stores/workspaces.test.ts`, find:

```ts
  it("seeds exactly one default workspace when mde:workspaces was never set", async () => {
    const { workspacesStore, activeWorkspaceIdStore } = await import("./workspaces");
    const workspaces = get(workspacesStore);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("My Workspace");
    expect(get(activeWorkspaceIdStore)).toBe(workspaces[0].id);
    expect(localStorage.getItem("mde:workspaces")).not.toBeNull();
  });
```

Change it to:

```ts
  it("starts with zero workspaces when mde:workspaces was never set, and persists that immediately", async () => {
    const { workspacesStore, activeWorkspaceIdStore } = await import("./workspaces");
    expect(get(workspacesStore)).toEqual([]);
    expect(get(activeWorkspaceIdStore)).toBeNull();
    expect(localStorage.getItem("mde:workspaces")).toBe("[]");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/stores/workspaces.test.ts`
Expected: FAIL — the store still seeds `[{ name: "My Workspace", ... }]`.

- [ ] **Step 3: Write the implementation**

In `client/src/stores/workspaces.ts`, find:

```ts
const initialWorkspaces: Workspace[] =
  storedWorkspaces === null ? [{ id: uid(), name: "My Workspace", createdAt: Date.now() }] : storedWorkspaces;
```

Change to:

```ts
const initialWorkspaces: Workspace[] = storedWorkspaces === null ? [] : storedWorkspaces;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/stores/workspaces.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc --noEmit -p client/tsconfig.json && npm test`
Expected: clean, all pass. (Other tests that assume a seeded default workspace — e.g. `docs.test.ts`'s tests using `get(workspacesStore)[0].id` as "the first workspace" — create their own workspaces explicitly via `createWorkspace(...)` already, per the existing pattern in that file, so this change shouldn't break them; the full suite run here confirms that.)

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/workspaces.ts client/src/stores/workspaces.test.ts
git commit -m "feat: stop seeding a default workspace on fresh installs"
```

---

### Task 2: Tier 2 guards — document-creation entry points

**Files:**
- Modify: `client/src/app.ts`
- Modify: `client/src/stores/docs.ts` (comment only)

**Interfaces:**
- Consumes: `workspacesStore` (`./stores/workspaces`), `showToast` (`./stores/toast`), `get` (`svelte/store`) — all three already imported in `app.ts`.

- [ ] **Step 1: Guard `createNewDoc`**

In `client/src/app.ts`, find:

```ts
  // Shared by the sidebar's "+" button and File > New document (MenuBar.svelte
  // via window.MDE.newDoc).
  function createNewDoc() {
    createDoc();
    (document.getElementById("docTitle") as HTMLInputElement).focus();
    (document.getElementById("docTitle") as HTMLInputElement).select();
  }
```

Change to:

```ts
  // Shared by the sidebar's "+" button and File > New document (MenuBar.svelte
  // via window.MDE.newDoc). Guarded here (not just via a disabled button)
  // so the Command Palette's own "New document" entry — which calls
  // window.MDE.newDoc() directly — is covered too.
  function createNewDoc() {
    if (get(workspacesStore).length === 0) {
      showToast("Create a workspace first", "error");
      return;
    }
    createDoc();
    (document.getElementById("docTitle") as HTMLInputElement).focus();
    (document.getElementById("docTitle") as HTMLInputElement).select();
  }
```

- [ ] **Step 2: Guard `openLocalFile`**

In the same file, find:

```ts
    openLocalFile() {
      document.getElementById("importInput").click();
    },
```

Change to:

```ts
    openLocalFile() {
      if (get(workspacesStore).length === 0) {
        showToast("Create a workspace first", "error");
        return;
      }
      document.getElementById("importInput").click();
    },
```

- [ ] **Step 3: Update `createDoc`'s self-heal comment**

In `client/src/stores/docs.ts`, find:

```ts
export function createDoc(partial?: Partial<Doc> & { id?: string; name?: string }): Doc {
  saveActiveDocContent();
  // Several call sites (sidebar "+", File > New, import-from-device,
  // Open-from-Gist, wikilink auto-create, shared-link join) can all reach
  // this with zero workspaces existing (the empty state only hides the
  // editor panes, not those entry points). Rather than ever stamping ""
  // — which DocList's `d.workspaceId === $activeWorkspaceIdStore` filter
  // can never match, orphaning the doc invisibly — self-heal by creating
  // a workspace on demand.
  let workspaceId = get(activeWorkspaceIdStore) ?? get(workspacesStore)[0]?.id;
  if (!workspaceId) workspaceId = createWorkspace("My Workspace").id;
```

Change the comment to:

```ts
export function createDoc(partial?: Partial<Doc> & { id?: string; name?: string }): Doc {
  saveActiveDocContent();
  // Every real entry point (sidebar "+", File > New, import-from-device,
  // Open-from-Gist, Link Workspace to Repo) now guards against zero
  // workspaces before ever calling this — see app.ts's createNewDoc/
  // openLocalFile, gist.ts's openGistPicker, repo-sync-ui.ts's
  // openRepoLinkModal. This fallback should be unreachable in normal
  // operation; it's kept as a defensive last resort so a missed guard
  // produces a usable workspace instead of silently stamping "" — which
  // DocList's `d.workspaceId === $activeWorkspaceIdStore` filter can
  // never match, orphaning the doc invisibly.
  let workspaceId = get(activeWorkspaceIdStore) ?? get(workspacesStore)[0]?.id;
  if (!workspaceId) workspaceId = createWorkspace("My Workspace").id;
```

The code on the next line is unchanged — only the comment above it changes.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass — `docs.test.ts`'s existing `createDoc self-heals by creating a workspace on demand when none exist` test already covers the fallback path this task's comment update describes; it needs no code change and should still pass unmodified.

- [ ] **Step 6: Manual verification**

Run the dev server (`npm run dev:client`), clear the site's storage (DevTools > Application > Clear site data, or a private/incognito window) to land on a genuinely fresh install, and confirm:
- The "No workspace yet" empty state shows (not the normal editor).
- Clicking the sidebar "+" (if visible) or File > New document shows the "Create a workspace first" toast and does nothing else.
- Clicking "New workspace" in the empty state works normally, and afterward File > New document / sidebar "+" work normally too.

- [ ] **Step 7: Commit**

```bash
git add client/src/app.ts client/src/stores/docs.ts
git commit -m "feat: gate New document / Open from device on a workspace existing"
```

---

### Task 3: Tier 2 guards — Gist and GitHub Repo entry points

**Files:**
- Modify: `client/src/gist.ts`
- Modify: `client/src/repo-sync-ui.ts`

**Interfaces:**
- Consumes: `workspacesStore` (`./stores/workspaces`), `get` (`svelte/store`) — both need a new import in `gist.ts`; already imported in `repo-sync-ui.ts`. `showToast` (`./stores/toast`) needs a new import in `repo-sync-ui.ts` (which currently only imports the progress-toast variants); already imported in `gist.ts`.

- [ ] **Step 1: Guard `openGistPicker`**

In `client/src/gist.ts`, find:

```ts
import { getActiveDoc, setActiveDocGistId, clearActiveDocGist } from "./stores/docs";
```

Change to:

```ts
import { getActiveDoc, setActiveDocGistId, clearActiveDocGist } from "./stores/docs";
import { workspacesStore } from "./stores/workspaces";
import { get } from "svelte/store";
```

Find:

```ts
// File > Open > From GitHub Gist... (MenuBar.svelte) — the modal itself
// (OpenGistModal.svelte) owns its own list-loading, so this just opens it.
function openGistPicker() {
  openGistModalOpen.set(true);
}
```

Change to:

```ts
// File > Open > From GitHub Gist... (MenuBar.svelte) — the modal itself
// (OpenGistModal.svelte) owns its own list-loading, so this just opens it.
// Guarded here (not just via a disabled menu item) so any other trigger
// of window.MDE.openGistPicker() is covered too, same reasoning as
// app.ts's createNewDoc/openLocalFile guards.
function openGistPicker() {
  if (get(workspacesStore).length === 0) {
    showToast("Create a workspace first", "error");
    return;
  }
  openGistModalOpen.set(true);
}
```

- [ ] **Step 2: Guard `openRepoLinkModal`**

In `client/src/repo-sync-ui.ts`, find:

```ts
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast } from "./stores/toast";
```

Change to:

```ts
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast, showToast } from "./stores/toast";
```

Find:

```ts
window.MDE.openRepoLinkModal = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    repoLinkModalOpen.set(true);
  })();
};
```

Change to:

```ts
window.MDE.openRepoLinkModal = () => {
  void (async () => {
    if (get(workspacesStore).length === 0) {
      showToast("Create a workspace first", "error");
      return;
    }
    if (!(await requireRepoScope())) return;
    repoLinkModalOpen.set(true);
  })();
};
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Manual verification**

With a genuinely fresh install (cleared storage), confirm File > Open > From GitHub Gist... and File > GitHub Repo > Link Workspace to Repo... both show the "Create a workspace first" toast instead of opening their modal. After creating a workspace, confirm both open normally again.

- [ ] **Step 6: Commit**

```bash
git add client/src/gist.ts client/src/repo-sync-ui.ts
git commit -m "feat: gate Gist and GitHub Repo linking on a workspace existing"
```

---

### Task 4: Tier 3 — disable document-scoped menu items with no active document

**Files:**
- Modify: `client/src/components/MenuBar.svelte`

**Interfaces:**
- Consumes: `activeDoc` (already a `$derived` in this file).
- Produces: `hasActiveDoc` derived value, used as `disabled={!hasActiveDoc}` across the File and Edit menus.

- [ ] **Step 1: Add the derived value**

In `client/src/components/MenuBar.svelte`, find:

```svelte
  const activeDoc = $derived($docsStore.find((d) => d.id === $activeIdStore));
  const hasGist = $derived(!!activeDoc?.gistId);
```

Change to:

```svelte
  const activeDoc = $derived($docsStore.find((d) => d.id === $activeIdStore));
  const hasActiveDoc = $derived(!!activeDoc);
  const hasGist = $derived(!!activeDoc?.gistId);
```

- [ ] **Step 2: Disable the File menu's document-scoped items**

Find each of these buttons/elements and add `disabled={!hasActiveDoc}` (or, for the `<a>` "View Gist" link, `aria-disabled={!hasActiveDoc}` plus guarding its click — see the note after this step). Find:

```svelte
      <button id="menuPublishSignedOut" type="button" hidden={!!$githubUsername} onclick={() => act(() => window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue."))}>
        <svg class="icon"><use href="#icon-rocket"></use></svg> Publish to Gist
      </button>
```

Change to:

```svelte
      <button id="menuPublishSignedOut" type="button" disabled={!hasActiveDoc} hidden={!!$githubUsername} onclick={() => act(() => window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue."))}>
        <svg class="icon"><use href="#icon-rocket"></use></svg> Publish to Gist
      </button>
```

Find:

```svelte
          <button id="menuPublishGist" type="button" disabled={gistBusy} onclick={() => act(() => window.MDE.publishGist?.())}>
```

Change to:

```svelte
          <button id="menuPublishGist" type="button" disabled={gistBusy || !hasActiveDoc} onclick={() => act(() => window.MDE.publishGist?.())}>
```

Find the Export submenu:

```svelte
          <button type="button" onclick={() => act(() => window.MDE.exportAs("md"))}><svg class="icon"><use href="#icon-download"></use></svg> Markdown (.md)</button>
          <button type="button" onclick={() => act(() => window.MDE.exportAs("html"))}><svg class="icon"><use href="#icon-download"></use></svg> HTML (.html)</button>
          <button type="button" onclick={() => act(() => window.MDE.exportAs("pdf"))}><svg class="icon"><use href="#icon-download"></use></svg> PDF (.pdf)</button>
          <button type="button" onclick={() => act(() => window.MDE.exportAs("txt"))}><svg class="icon"><use href="#icon-download"></use></svg> Plain text (.txt)</button>
```

Change to:

```svelte
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("md"))}><svg class="icon"><use href="#icon-download"></use></svg> Markdown (.md)</button>
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("html"))}><svg class="icon"><use href="#icon-download"></use></svg> HTML (.html)</button>
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("pdf"))}><svg class="icon"><use href="#icon-download"></use></svg> PDF (.pdf)</button>
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("txt"))}><svg class="icon"><use href="#icon-download"></use></svg> Plain text (.txt)</button>
```

Find:

```svelte
      <button id="menuComments" type="button" onclick={() => act(() => commentsPanelOpen.set(true))}>
        <svg class="icon"><use href="#icon-message-square"></use></svg> Comments
      </button>
```

Change to:

```svelte
      <button id="menuComments" type="button" disabled={!hasActiveDoc} onclick={() => act(() => commentsPanelOpen.set(true))}>
        <svg class="icon"><use href="#icon-message-square"></use></svg> Comments
      </button>
```

Find:

```svelte
      <button id="menuVersionHistory" type="button" onclick={() => act(() => versionHistoryOpen.set(true))}>
        <svg class="icon"><use href="#icon-history"></use></svg> Version history
      </button>
```

Change to:

```svelte
      <button id="menuVersionHistory" type="button" disabled={!hasActiveDoc} onclick={() => act(() => versionHistoryOpen.set(true))}>
        <svg class="icon"><use href="#icon-history"></use></svg> Version history
      </button>
```

Find:

```svelte
      <button id="menuDocInfo" type="button" onclick={() => act(() => docInfoPanelOpen.set(true))}>
        <svg class="icon"><use href="#icon-info"></use></svg> Document info
      </button>
```

Change to:

```svelte
      <button id="menuDocInfo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => docInfoPanelOpen.set(true))}>
        <svg class="icon"><use href="#icon-info"></use></svg> Document info
      </button>
```

Find:

```svelte
      <button id="menuDeleteDoc" type="button" onclick={() => act(() => deleteDoc($activeIdStore ?? ""))}>
        <svg class="icon"><use href="#icon-trash-2"></use></svg> Delete document
      </button>
```

Change to:

```svelte
      <button id="menuDeleteDoc" type="button" disabled={!hasActiveDoc} onclick={() => act(() => deleteDoc($activeIdStore ?? ""))}>
        <svg class="icon"><use href="#icon-trash-2"></use></svg> Delete document
      </button>
```

- [ ] **Step 3: Disable the entire Edit menu**

Find the whole Edit menu panel:

```svelte
    <div bind:this={editMenu} id="editMenu" class="dropdown-menu menubar-menu">
      <button id="menuUndo" type="button" onclick={() => act(() => window.MDE.undo())}><svg class="icon"><use href="#icon-undo-2"></use></svg> Undo <kbd>Ctrl+Z</kbd></button>
      <button id="menuRedo" type="button" onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
      <button id="menuCopy" type="button" onclick={() => act(() => window.MDE.copySelection())}><svg class="icon"><use href="#icon-copy"></use></svg> Copy <kbd>Ctrl+C</kbd></button>
      <button id="menuPaste" type="button" onclick={() => act(() => window.MDE.pasteClipboard())}><svg class="icon"><use href="#icon-clipboard"></use></svg> Paste <kbd>Ctrl+V</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuBold" type="button" class="menu-glyph-btn" onclick={() => act(() => formatCmd("bold"))}><b>B</b> Bold <kbd>Ctrl+B</kbd></button>
      <button id="menuItalic" type="button" class="menu-glyph-btn" onclick={() => act(() => formatCmd("italic"))}><i>I</i> Italic <kbd>Ctrl+I</kbd></button>
      <button id="menuStrike" type="button" onclick={() => act(() => formatCmd("strike"))}><svg class="icon"><use href="#icon-strikethrough"></use></svg> Strikethrough</button>
      <div class="menu-divider"></div>
      <button id="menuLink" type="button" onclick={() => act(() => window.MDE.runCmd("link"))}><svg class="icon"><use href="#icon-link"></use></svg> Insert Link... <kbd>Ctrl+K</kbd></button>
      <button id="menuImage" type="button" onclick={() => act(() => window.MDE.runCmd("image"))}><svg class="icon"><use href="#icon-image"></use></svg> Insert Image...</button>
      <button id="menuManageImages" type="button" onclick={() => act(() => window.MDE.openImagesManager())}><svg class="icon"><use href="#icon-images"></use></svg> Manage Images...</button>
    </div>
```

Change to:

```svelte
    <div bind:this={editMenu} id="editMenu" class="dropdown-menu menubar-menu">
      <button id="menuUndo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.undo())}><svg class="icon"><use href="#icon-undo-2"></use></svg> Undo <kbd>Ctrl+Z</kbd></button>
      <button id="menuRedo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
      <button id="menuCopy" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.copySelection())}><svg class="icon"><use href="#icon-copy"></use></svg> Copy <kbd>Ctrl+C</kbd></button>
      <button id="menuPaste" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.pasteClipboard())}><svg class="icon"><use href="#icon-clipboard"></use></svg> Paste <kbd>Ctrl+V</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuBold" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("bold"))}><b>B</b> Bold <kbd>Ctrl+B</kbd></button>
      <button id="menuItalic" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("italic"))}><i>I</i> Italic <kbd>Ctrl+I</kbd></button>
      <button id="menuStrike" type="button" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("strike"))}><svg class="icon"><use href="#icon-strikethrough"></use></svg> Strikethrough</button>
      <div class="menu-divider"></div>
      <button id="menuLink" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("link"))}><svg class="icon"><use href="#icon-link"></use></svg> Insert Link... <kbd>Ctrl+K</kbd></button>
      <button id="menuImage" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("image"))}><svg class="icon"><use href="#icon-image"></use></svg> Insert Image...</button>
      <button id="menuManageImages" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.openImagesManager())}><svg class="icon"><use href="#icon-images"></use></svg> Manage Images...</button>
    </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass (this codebase has no Svelte component tests, so nothing in the suite directly exercises `MenuBar.svelte` — this step confirms the change hasn't broken anything else).

- [ ] **Step 6: Manual verification**

With a workspace that exists but has no active document (e.g. delete the last document in a workspace, landing on the "has-workspace" empty state), open the File menu and confirm Publish to Gist, GitHub Repo submenu's Pull/Push (if linked), Export, Comments, Version history, Document info, and Delete document are all visibly greyed out and unclickable, and the entire Edit menu is greyed out too. Then open a document and confirm every one of those re-enables.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/MenuBar.svelte
git commit -m "feat: disable document-scoped menu items when no document is active"
```

---

### Task 5: Join-flow simplification

**Files:**
- Modify: `client/src/collab.ts`

**Interfaces:**
- Consumes: `workspacesStore`, `adoptSharedWorkspace`, `switchWorkspace` (already imported from `./stores/workspaces`); `switchDoc` (already imported from `./stores/docs`); `get` (already imported from `svelte/store`).
- New import needed: `importRemoteDocs` from `./stores/docs`.

- [ ] **Step 1: Add the missing import**

In `client/src/collab.ts`, find:

```ts
import { getActiveDoc, switchDoc, docsStore, moveDocToWorkspace, findDocById, persistDocs } from "./stores/docs";
```

Change to:

```ts
import { getActiveDoc, switchDoc, docsStore, moveDocToWorkspace, findDocById, persistDocs, importRemoteDocs } from "./stores/docs";
```

- [ ] **Step 2: Update `joinSharedLink`**

Find:

```ts
  const docIds = await fetchWorkspaceDocIds(workspaceId);
  const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
  pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: docs.filter((d): d is NonNullable<typeof d> => !!d), landOnDocId });
}
```

Change to:

```ts
  const docIds = await fetchWorkspaceDocIds(workspaceId);
  const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
  const validDocs = docs.filter((d): d is NonNullable<typeof d> => !!d);

  // A receiver with zero workspaces has nothing to choose between — skip
  // straight to what "Add as new workspace" already does today, instead
  // of asking a question that isn't really a question. An existing user
  // (any workspace at all) still gets the normal choice via pendingJoin.
  if (get(workspacesStore).length === 0) {
    const ws = adoptSharedWorkspace(workspaceId, "Shared workspace");
    importRemoteDocs(ws.id, validDocs);
    switchWorkspace(ws.id);
    switchDoc(landOnDocId);
    return;
  }

  pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: validDocs, landOnDocId });
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Manual verification**

This flow needs a real GitHub session and a real shared-link URL, which aren't available in `dev:client`-only mode — verify via code review and the typecheck/test results from this task, consistent with how this codebase handles other GitHub-session-gated flows it can't fully exercise locally. If you want to verify live, this needs the full `npm run dev` stack (a real Worker + GitHub OAuth) with a workspace actually shared from another account — flag this to the user rather than attempting it blind.

- [ ] **Step 6: Commit**

```bash
git add client/src/collab.ts
git commit -m "feat: skip the join-workspace dialog for a receiver with no workspaces"
```

---

### Task 6: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including Task 1's updated `workspaces.test.ts` test.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated to this work).

- [ ] **Step 4: End-to-end manual pass on a fresh install**

With genuinely cleared storage: confirm the "No workspace yet" empty state shows; every Tier 2 action (sidebar "+", File > New, Open from device, Open from GitHub Gist, Link Workspace to Repo) shows the "Create a workspace first" toast; "New workspace" and "Open GitHub Repo as Workspace" both work and immediately drop you into a usable workspace; and once a workspace exists, every previously-blocked action works normally again.
