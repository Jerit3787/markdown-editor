# Empty State Repo Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The "No workspace yet" empty state offers a second way in, alongside "New workspace": opening a GitHub repo directly as a workspace.

**Architecture:** One new button in `client/index.html`'s no-workspace empty state, wired in `app.ts` by delegating to the existing `#menuOpenRepo` File-menu item's click handler — the same pattern every other empty-state button in this file already follows.

**Tech Stack:** HTML, TypeScript.

## Global Constraints

- The new button delegates to `#menuOpenRepo`'s existing click handler (`document.getElementById("menuOpenRepo").click()`) — it must not call `window.MDE.openRepoModal` directly, to stay consistent with how every other empty-state button in `initEmptyState()` already works.
- No guard needed — "Open GitHub Repo as Workspace" is a Tier 1, always-available action.

---

### Task 1: Add the button and wire it up

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/app.ts`

**Interfaces:**
- None — purely additive markup plus one `addEventListener` call, no new functions or exports.

- [ ] **Step 1: Add the button to the empty state**

In `client/index.html`, find:

```html
        <div class="empty-state-inner empty-state-no-workspace">
          <img src="/logo.svg" width="52" height="52" alt="">
          <h1>No workspace yet</h1>
          <p>Create a workspace to start adding documents.</p>
          <div class="empty-state-actions">
            <button type="button" id="emptyNewWorkspaceBtn" class="primary-btn"><svg class="icon"><use href="#icon-plus"></use></svg> New workspace</button>
          </div>
        </div>
```

Change to:

```html
        <div class="empty-state-inner empty-state-no-workspace">
          <img src="/logo.svg" width="52" height="52" alt="">
          <h1>No workspace yet</h1>
          <p>Create a workspace to start adding documents.</p>
          <div class="empty-state-actions">
            <button type="button" id="emptyNewWorkspaceBtn" class="primary-btn"><svg class="icon"><use href="#icon-plus"></use></svg> New workspace</button>
            <button type="button" id="emptyOpenRepoBtn" class="secondary-btn"><svg class="icon"><use href="#icon-github"></use></svg> Open from GitHub Repo</button>
          </div>
        </div>
```

- [ ] **Step 2: Wire the click handler**

In `client/src/app.ts`, find:

```ts
  function initEmptyState() {
    document.getElementById("emptyNewDocBtn").addEventListener("click", () => {
      document.getElementById("newDocBtn").click();
    });
    document.getElementById("emptyOpenLocalBtn").addEventListener("click", () => {
      document.getElementById("importInput").click();
    });
    document.getElementById("emptyOpenGistBtn").addEventListener("click", () => {
      document.getElementById("menuOpenGist").click();
    });
    document.getElementById("emptyNewWorkspaceBtn").addEventListener("click", () => {
      const ws = createWorkspace("New workspace");
      updateMainView(true); // re-run the empty-state check now that a workspace exists
      // Focus the new workspace's name for immediate renaming, same as
      // the switcher's own "New workspace" button — see WorkspaceSwitcher.svelte.
      document.getElementById("workspace-switcher-mount")?.querySelector("button")?.click();
    });
  }
```

Change to:

```ts
  function initEmptyState() {
    document.getElementById("emptyNewDocBtn").addEventListener("click", () => {
      document.getElementById("newDocBtn").click();
    });
    document.getElementById("emptyOpenLocalBtn").addEventListener("click", () => {
      document.getElementById("importInput").click();
    });
    document.getElementById("emptyOpenGistBtn").addEventListener("click", () => {
      document.getElementById("menuOpenGist").click();
    });
    document.getElementById("emptyNewWorkspaceBtn").addEventListener("click", () => {
      const ws = createWorkspace("New workspace");
      updateMainView(true); // re-run the empty-state check now that a workspace exists
      // Focus the new workspace's name for immediate renaming, same as
      // the switcher's own "New workspace" button — see WorkspaceSwitcher.svelte.
      document.getElementById("workspace-switcher-mount")?.querySelector("button")?.click();
    });
    document.getElementById("emptyOpenRepoBtn").addEventListener("click", () => {
      document.getElementById("menuOpenRepo").click();
    });
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no automated coverage touches `index.html` or `initEmptyState`).

- [ ] **Step 5: Manual verification**

With `npm run dev:client`, clear storage to land on a genuinely empty workspace list, and confirm the "No workspace yet" empty state shows both "New workspace" and "Open from GitHub Repo" buttons, and that clicking the latter opens the same modal as File > Open > From GitHub Repo.

- [ ] **Step 6: Commit**

```bash
git add client/index.html client/src/app.ts
git commit -m "feat: add an entry point to open a GitHub repo from the empty workspace state"
```

---

### Task 2: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated).

- [ ] **Step 4: Manual verification**

Already covered by Task 1's Step 5 — no GitHub auth needed for this one, `dev:client` alone is sufficient. Re-confirm if anything changed between Task 1 and this final pass.
