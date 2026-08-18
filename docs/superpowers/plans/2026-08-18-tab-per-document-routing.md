# Tab-Per-Document Routing (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each browser tab's URL reflects and drives which document is active — deep links work, browser back/forward works, switching documents updates the URL — and sidebar document rows become real links so Ctrl/Cmd-click or middle-click opens a document in a genuine new tab.

**Architecture:** A new small module, `client/src/router.ts`, owns URL parsing/pushing and the popstate listener, calling `docs.ts`'s existing `switchDoc` (which already switches the workspace too, if needed) to apply a URL to app state. `app.ts` calls `initRouter()` first thing in its `init()`, and its existing `activeIdStore.subscribe(...)` (which already fires on every way the active document can change, from any source) gets a small addition to push the URL on genuine changes. `DocList.svelte`'s rows get restructured so the clickable icon+name becomes a real `<a href>`, with a click handler that only intercepts a plain, unmodified left-click.

**Tech Stack:** TypeScript, Svelte 5, Vitest (jsdom environment for `history`/`location`).

## Global Constraints

- URL scheme: `/d/<docId>`, no mode suffix (a mode reflects a share link's granted role; these are your own local documents, always full access).
- `/d/<docId>` and the existing share-link pattern `/w/<workspaceId>/<docId>/<mode>` (`collab.ts`'s `SHARE_PATH`) are disjoint and need no ordering dependency between their handlers.
- A `/d/<docId>` URL for a document that doesn't exist locally falls back to `/` (same as no path at all) — it only makes sense within the browser profile that owns the document, unlike server-fetching share links.
- Only `DocList.svelte`'s sidebar rows get the real-anchor/native-new-tab treatment in this phase. Command Palette, "Open Recent," and wikilinks stay as-is (they still get URL-sync for free, just not Ctrl/Cmd-click-to-new-tab).
- `null` active document (empty state) uses `history.replaceState` back to `/`; a real document change uses `history.pushState`.

---

### Task 1: `router.ts` — URL parsing, pushing, and applying to app state

**Files:**
- Create: `client/src/router.ts`
- Test: `client/src/router.test.ts`

**Interfaces:**
- Consumes: `docsStore` and `switchDoc` from `client/src/stores/docs.ts` (`switchDoc(id: string): boolean` — already switches the workspace internally if the target document belongs to a different one than the currently active workspace; no separate `switchWorkspace` call is needed).
- Produces:
  ```ts
  export function parseDocIdFromPath(pathname: string): string | null
  export function pushDocUrl(docId: string): void
  export function replaceToRoot(): void
  export function initRouter(): void
  ```
  Task 2 calls `initRouter`, `pushDocUrl`, and `replaceToRoot` directly from `app.ts`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/router.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { parseDocIdFromPath, pushDocUrl, replaceToRoot } from "./router";

beforeEach(() => {
  history.replaceState(null, "", "/");
});

describe("parseDocIdFromPath", () => {
  it("extracts the doc id from a /d/<id> path", () => {
    expect(parseDocIdFromPath("/d/abc123")).toBe("abc123");
  });

  it("returns null for the root path", () => {
    expect(parseDocIdFromPath("/")).toBeNull();
  });

  it("returns null for a share link path", () => {
    expect(parseDocIdFromPath("/w/ws1/doc1/edit")).toBeNull();
  });

  it("returns null for a malformed /d/ path", () => {
    expect(parseDocIdFromPath("/d/")).toBeNull();
    expect(parseDocIdFromPath("/d/abc/extra")).toBeNull();
  });
});

describe("pushDocUrl", () => {
  it("pushes a new history entry with the doc's URL", () => {
    pushDocUrl("abc123");
    expect(location.pathname).toBe("/d/abc123");
  });

  it("does not push a redundant entry when already on that doc's URL", () => {
    history.pushState(null, "", "/d/abc123");
    const lengthBefore = history.length;
    pushDocUrl("abc123");
    expect(history.length).toBe(lengthBefore);
  });
});

describe("replaceToRoot", () => {
  it("replaces the current entry with /", () => {
    history.pushState(null, "", "/d/abc123");
    const lengthBefore = history.length;
    replaceToRoot();
    expect(location.pathname).toBe("/");
    expect(history.length).toBe(lengthBefore); // replace, not push — no new entry
  });

  it("does nothing when already at /", () => {
    const lengthBefore = history.length;
    replaceToRoot();
    expect(history.length).toBe(lengthBefore);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- router.test.ts`
Expected: FAIL — `Cannot find module './router'`.

- [ ] **Step 3: Implement `router.ts`**

Create `client/src/router.ts`:

```ts
import { get } from "svelte/store";
import { docsStore, switchDoc } from "./stores/docs";

const DOC_PATH = /^\/d\/([A-Za-z0-9]{1,64})$/;

export function parseDocIdFromPath(pathname: string): string | null {
  const match = pathname.match(DOC_PATH);
  return match ? match[1]! : null;
}

export function pushDocUrl(docId: string): void {
  const path = `/d/${docId}`;
  if (location.pathname !== path) history.pushState(null, "", path);
}

export function replaceToRoot(): void {
  if (location.pathname !== "/") history.replaceState(null, "", "/");
}

// Applies whatever /d/<id> is currently in the URL to app state — shared
// by initRouter's initial load and every popstate (back/forward) event.
// switchDoc (stores/docs.ts) already switches the workspace too if the
// target document belongs to a different one, so no separate
// switchWorkspace call is needed here.
function applyPathToState(): void {
  const docId = parseDocIdFromPath(location.pathname);
  if (!docId) return;
  const exists = get(docsStore).some((d) => d.id === docId);
  if (!exists) {
    replaceToRoot();
    return;
  }
  switchDoc(docId);
}

export function initRouter(): void {
  applyPathToState();
  window.addEventListener("popstate", applyPathToState);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- router.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/router.ts client/src/router.test.ts
git commit -m "feat: add router.ts for /d/<docId> URL parsing and navigation"
```

---

### Task 2: Wire the router into `app.ts`

**Files:**
- Modify: `client/src/app.ts` (add an import; call `initRouter()` as the first statement of `init()`, currently starting at line 184; extend the `activeIdStore.subscribe(...)` callback, currently at lines 221-230)

**Interfaces:**
- Consumes: `initRouter`, `pushDocUrl`, `replaceToRoot` from Task 1's `client/src/router.ts`.

No new test file. `app.ts` has no existing test infrastructure for its DOM-integration layer (no `app.test.ts` exists in this codebase) — this task's correctness is verified live in a browser (Step 3), matching the boundary already established around this file.

- [ ] **Step 1: Import the router functions**

In `client/src/app.ts`, add this import near the top of the file, after the existing `import { workspacesStore, createWorkspace } from "./stores/workspaces";` line:

```ts
import { initRouter, pushDocUrl, replaceToRoot } from "./router";
```

- [ ] **Step 2: Call `initRouter()` first, before anything else in `init()`**

The ordering matters: `initRouter()` must run — and finish applying any `/d/<id>` URL to `activeIdStore`/`activeWorkspaceIdStore` — *before* `init()` reaches its `activeIdStore.subscribe(...)` a few lines later, so that subscription's first (synchronous) fire already reflects the URL-driven document instead of loading the wrong one first and then flashing to the right one.

In `client/src/app.ts`, `init()` currently starts:

```ts
  function init() {
    // cm is already populated by this point — Editor.svelte constructs the
    // EditorView in its own onMount and hands it back via
    // window.MDE.registerEditor(), and main.ts's mount() calls (which
    // trigger that) run synchronously before this DOMContentLoaded handler
    // ever fires, same guarantee every other Svelte component here relies on.
    initSyncScroll();
```

Change it to:

```ts
  function init() {
    // Must run before the activeIdStore.subscribe below: it may switch the
    // active document (and workspace) synchronously from the current URL,
    // and that subscription's first fire needs to already reflect it —
    // otherwise the editor briefly loads the wrong document before
    // flashing to the right one.
    initRouter();

    // cm is already populated by this point — Editor.svelte constructs the
    // EditorView in its own onMount and hands it back via
    // window.MDE.registerEditor(), and main.ts's mount() calls (which
    // trigger that) run synchronously before this DOMContentLoaded handler
    // ever fires, same guarantee every other Svelte component here relies on.
    initSyncScroll();
```

- [ ] **Step 3: Push the URL from the existing `activeIdStore.subscribe` callback**

In `client/src/app.ts`, the existing subscription (currently lines 221-230):

```ts
    let lastLoadedId: string | null | undefined;
    let firstFire = true;
    activeIdStore.subscribe((id) => {
      if (!firstFire && id === lastLoadedId) return;
      firstFire = false;
      lastLoadedId = id;
      loadDocIntoEditor(getActiveDoc());
      updatePreview();
      updateCounts();
    });
```

becomes:

```ts
    let lastLoadedId: string | null | undefined;
    let firstFire = true;
    activeIdStore.subscribe((id) => {
      if (!firstFire && id === lastLoadedId) return;
      const isFirstFire = firstFire;
      firstFire = false;
      lastLoadedId = id;
      loadDocIntoEditor(getActiveDoc());
      updatePreview();
      updateCounts();
      // Skip the very first (synchronous, load-time) fire — initRouter()
      // already applied whatever URL the tab loaded with, so pushing here
      // too would be redundant. Every later fire is a genuine change
      // (switchDoc, "Open Recent", Command Palette, workspace switching
      // via ensureActiveDocInWorkspace — all of them end up here, since
      // this subscription is the one thing every path to changing
      // activeIdStore already funnels through).
      if (!isFirstFire) {
        if (id) pushDocUrl(id);
        else replaceToRoot();
      }
    });
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Verify live in a browser**

Run `npm run dev:client -- --port 5199` in the background, then in a browser tab:

1. Seed `localStorage` with a workspace and two documents (following the same pattern used earlier this session — `mde:workspaces`, `mde:docs`, `mde:activeWorkspace`, `mde:active`), navigate to `http://localhost:5199/`, and confirm the URL stays at `/` on initial load (no auto-redirect to a `/d/...` URL just from opening the app).
2. Switch to the second document via the sidebar. Confirm the URL becomes `/d/<that doc's id>`.
3. Click the browser's back button. Confirm the app switches back to the first document and the URL updates accordingly.
4. Navigate directly to `http://localhost:5199/d/<a-real-doc-id>`. Confirm that document loads as active (and its workspace becomes the active workspace, if it belongs to a different one).
5. Navigate to `http://localhost:5199/d/does-not-exist`. Confirm it falls back to `/` cleanly (no error, no blank page) and shows whatever document the local-storage fallback picks.
6. Check the browser console for errors (`read_console_messages`, `onlyErrors: true`).
7. Stop the dev server and close the browser tab when done.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions (this task adds no new automated tests of its own, per the Interfaces note above).

- [ ] **Step 7: Commit**

```bash
git add client/src/app.ts
git commit -m "feat: sync the active document with the URL"
```

---

### Task 3: Sidebar rows become real links

**Files:**
- Modify: `client/src/components/DocList.svelte` (the row markup, currently around lines 139-164, and the `select` function at lines 51-53)
- Modify: `client/src/style.css` (add one new rule near the existing `.doc-row` rules, currently around line 1586-1638)

**Interfaces:**
- Consumes: nothing new from Tasks 1-2 directly — relies on `/d/<docId>` being a URL that Task 2's wiring already understands when clicked normally (the existing in-tab `select()` → `window.MDE.switchDoc()` path already triggers Task 2's push-on-change logic).

No new automated test — this is Svelte template/CSS restructuring with no dedicated test infrastructure in this codebase (see Task 2's note; the same boundary applies to every `.svelte` file). Verified live in Step 3.

- [ ] **Step 1: Restructure the row markup**

In `client/src/components/DocList.svelte`, the current row (lines 139-164) is:

```svelte
        <div class="doc-row" onclick={() => select(doc.id)}>
          {#if headings.length > 0}
            <button
              type="button"
              class="doc-outline-toggle"
              class:expanded={expandedIds.has(doc.id)}
              aria-label={expandedIds.has(doc.id) ? "Hide outline" : "Show outline"}
              onclick={(e) => toggleOutline(doc.id, e)}
            >
              <svg class="icon"><use href="#icon-chevron-right"></use></svg>
            </button>
          {:else}
            <span class="doc-outline-toggle-spacer"></span>
          {/if}
          <svg class="icon doc-icon"><use href="#icon-file"></use></svg>
          <span class="doc-name">{doc.name || "Untitled"}</span>
          {#if ($workspacePresence.get(doc.id) || []).length > 0}
            <span class="doclist-presence">
              {#each ($workspacePresence.get(doc.id) || []).slice(0, 3) as p (p.username)}
                <span class="presence-avatar presence-avatar-sm" style:background={p.color} title={p.username}>{p.username.charAt(0).toUpperCase()}</span>
              {/each}
            </span>
          {/if}
          <button type="button" class="doc-menu-btn" class:active={openMenuId === doc.id} aria-label="Document options" onclick={(e) => openMenu(doc.id, e)}>
            <svg class="icon"><use href="#icon-ellipsis-vertical"></use></svg>
          </button>
```

Replace it with:

```svelte
        <div class="doc-row">
          {#if headings.length > 0}
            <button
              type="button"
              class="doc-outline-toggle"
              class:expanded={expandedIds.has(doc.id)}
              aria-label={expandedIds.has(doc.id) ? "Hide outline" : "Show outline"}
              onclick={(e) => toggleOutline(doc.id, e)}
            >
              <svg class="icon"><use href="#icon-chevron-right"></use></svg>
            </button>
          {:else}
            <span class="doc-outline-toggle-spacer"></span>
          {/if}
          <a class="doc-row-link" href={`/d/${doc.id}`} onclick={(e) => onRowLinkClick(e, doc.id)}>
            <svg class="icon doc-icon"><use href="#icon-file"></use></svg>
            <span class="doc-name">{doc.name || "Untitled"}</span>
            {#if ($workspacePresence.get(doc.id) || []).length > 0}
              <span class="doclist-presence">
                {#each ($workspacePresence.get(doc.id) || []).slice(0, 3) as p (p.username)}
                  <span class="presence-avatar presence-avatar-sm" style:background={p.color} title={p.username}>{p.username.charAt(0).toUpperCase()}</span>
                {/each}
              </span>
            {/if}
          </a>
          <button type="button" class="doc-menu-btn" class:active={openMenuId === doc.id} aria-label="Document options" onclick={(e) => openMenu(doc.id, e)}>
            <svg class="icon"><use href="#icon-ellipsis-vertical"></use></svg>
          </button>
```

Note the `<!-- svelte-ignore a11y_click_events_have_key_events -->` / `<!-- svelte-ignore a11y_no_static_element_interactions -->` comments immediately above the old `<div class="doc-row" onclick=...>` line (from the original file) are no longer needed on the outer `<div>`, since it no longer has a click handler or interactive role of its own — the `<a>` is now the real interactive element. Delete those two comment lines.

- [ ] **Step 2: Add the click handler, distinguishing a plain click from a modified one**

In `client/src/components/DocList.svelte`, the existing `select` function (lines 51-53):

```ts
  function select(id: string) {
    window.MDE.switchDoc(id);
  }
```

Add a new function right after it:

```ts
  // A plain left-click does the existing in-tab switch. Ctrl/Cmd-click,
  // Shift-click, and any non-primary button are left alone entirely —
  // the browser's native "open link" handling is what actually opens a
  // new tab, and calling preventDefault() unconditionally here would
  // silently swallow every modified click into an in-tab switch instead,
  // defeating the point of this being a real link at all. Middle-click
  // doesn't reach this handler in the first place (it fires `auxclick`,
  // not `click`, in modern browsers), so it already opens a new tab via
  // native behavior with no extra handling needed here.
  function onRowLinkClick(e: MouseEvent, id: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    select(id);
  }
```

- [ ] **Step 3: Add the `.doc-row-link` CSS rule**

In `client/src/style.css`, add this immediately after the existing `.doc-row:hover { background: var(--border); }` rule (currently line 1596):

```css
.doc-row-link {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}
```

The existing `.doc-row .doc-icon` and `.doc-row .doc-name` rules (lines 1616, 1618) need no changes — they're plain descendant selectors, not direct-child selectors, so they still match the icon and name now that there's an extra `.doc-row-link` level between `.doc-row` and them.

- [ ] **Step 4: Verify live in a browser**

Using the same dev server and seeded `localStorage` from Task 2's Step 5 (restart it if it was stopped):

1. Confirm the sidebar still looks and behaves identically to before for a plain click — clicking a document row's name/icon switches to it in-tab, and the row's outline toggle and "..." menu button still work independently (clicking them must not trigger a navigation).
2. Ctrl-click (or Cmd-click on macOS) a document row. Confirm a new browser tab opens showing that document, and the original tab's active document is unchanged.
3. Middle-click a document row (if your input device supports it; otherwise skip this specific check but keep the others). Confirm the same new-tab behavior.
4. Right-click a document row and confirm the browser's native context menu offers "Open link in new tab" (proves it's a genuine anchor, not just styled to look like one).
5. Check the browser console for errors.
6. Stop the dev server and close the browser tab(s) when done.

- [ ] **Step 5: Run the full test suite and type-check**

Run: `npm test`
Expected: PASS — no regressions.

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/DocList.svelte client/src/style.css
git commit -m "feat: sidebar document rows are real links, opening in a new tab on Ctrl/Cmd-click"
```
