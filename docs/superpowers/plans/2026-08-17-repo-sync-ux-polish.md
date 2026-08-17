# Repo-Sync UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linking a workspace to a repo picks up a sensible name automatically when unnamed; opening a repo closes its picker modal immediately instead of sitting on top of the progress toast; the GitHub Repo submenu shows time since last sync; and every dropdown in the app gets consistent themed styling.

**Architecture:** Four small, independent changes in the repo-sync area: a rename check added to `linkWorkspaceAndSync`, a `close()` reordering in two modal components, a new `repoLastSyncedAt` field on `Workspace` wired through `pushToRepo`/`pullFromRepo` and displayed in `MenuBar.svelte`, and one new shared CSS rule for bare `<select>` elements.

**Tech Stack:** TypeScript, Svelte 5, Vitest.

## Global Constraints

- The auto-rename (item 6) only fires when the workspace's current name is exactly `"New workspace"` — any other name (including a name the user already customized) is left untouched.
- `repoLastSyncedAt` is a single combined timestamp updated by both push and pull, not two separate fields — no live-updating countdown, it renders once per reactivity pass like every other relative-time display in this app.
- No automated coverage for the Svelte component changes (modal close timing, CSS styling) — matches this codebase's established precedent of no Svelte component tests.

---

### Task 1: Auto-rename a still-default-named workspace on link

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `renameWorkspace(id: string, name: string): void` (already exported from `./stores/workspaces`, not yet imported in this file), `nextAvailableName` (already imported from `./doc-naming`), `get` (already imported from `svelte/store`), `workspacesStore` (already imported).

- [ ] **Step 1: Write the failing tests**

In `client/src/repo-sync.test.ts`, add these two tests inside the existing `describe("linkWorkspaceAndSync", ...)` block, right after its last test (`"pushes directly instead of conflicting when relinking to a repo this exact workspace already pushed to before"`):

```ts
  it("renames a still-default-named workspace to the repo's name when linking", async () => {
    const ws = createWorkspace("New workspace");
    backend.seedRepo("alice", "my-blog", "main", []);

    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "my-blog", branch: "main" });

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("my-blog");
  });

  it("leaves a custom-named workspace's name untouched when linking", async () => {
    const ws = createWorkspace("Personal Notes");
    backend.seedRepo("alice", "my-blog", "main", []);

    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "my-blog", branch: "main" });

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("Personal Notes");
  });
```

Add `workspacesStore` to the existing import from `./stores/workspaces`. Find:

```ts
import { createWorkspace } from "./stores/workspaces";
```

Change to:

```ts
import { createWorkspace, workspacesStore } from "./stores/workspaces";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — the first new test fails because the workspace is never renamed (`"New workspace"` stays as-is instead of becoming `"my-blog"`); the second test passes already (nothing renames a custom name today, so it trivially holds) — that's fine, it's there to guard the coming change.

- [ ] **Step 3: Implement the rename check**

In `client/src/repo-sync.ts`, find:

```ts
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace } from "./stores/workspaces";
```

Change to:

```ts
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace, renameWorkspace } from "./stores/workspaces";
```

Find:

```ts
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
```

Change to:

```ts
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  // Only a workspace still carrying its generic creation-time default
  // gets renamed — the same literal both workspace-creation entry points
  // (WorkspaceSwitcher.svelte's startCreate, the empty state's "New
  // workspace" button) use before the user picks a real name. A
  // workspace created via "Open GitHub Repo as Workspace" is already
  // named after its repo by the time it could ever reach this function,
  // so this only ever fires for linking an *existing* workspace.
  const workspace = get(workspacesStore).find((w) => w.id === workspaceId);
  if (workspace && workspace.name === "New workspace") {
    const taken = new Set(get(workspacesStore).filter((w) => w.id !== workspaceId).map((w) => w.name));
    renameWorkspace(workspaceId, nextAvailableName(repoLink.repo, taken));
  }
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: rename a still-default-named workspace to match its linked repo"
```

---

### Task 2: Close the picker modal immediately, not after the sync

**Files:**
- Modify: `client/src/components/OpenRepoModal.svelte`
- Modify: `client/src/components/RepoLinkModal.svelte`

**Interfaces:**
- None — purely reorders an existing `close()` call within each component's own handler, no signature changes.

- [ ] **Step 1: Update `OpenRepoModal.svelte`**

Find:

```ts
  async function pickRepo(owner: string, repo: string, branch: string) {
    try {
      await createWorkspaceFromRepo(owner, repo, branch);
      close();
    } catch (err: any) {
      // createWorkspaceFromRepo already finished its own progress toast
      // as an error — nothing left to show here.
    }
  }
```

Change to:

```ts
  async function pickRepo(owner: string, repo: string, branch: string) {
    // Closed immediately, before the pull even starts — otherwise this
    // modal stays open the whole time, its own busy-button state
    // competing with createWorkspaceFromRepo's separate progress toast
    // for attention instead of the toast being the sole indicator.
    close();
    try {
      await createWorkspaceFromRepo(owner, repo, branch);
    } catch (err: any) {
      // createWorkspaceFromRepo already finished its own progress toast
      // as an error — nothing left to show here.
    }
  }
```

- [ ] **Step 2: Update `RepoLinkModal.svelte`**

Find:

```ts
  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    try {
      const result = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      close();
      if (result.kind === "push-conflict") {
```

Change to:

```ts
  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    // Closed immediately, before the sync even starts — same reasoning
    // as OpenRepoModal.svelte's pickRepo: the progress toast should be
    // the only "what's happening" indicator on screen, not competing
    // with a still-open modal for the whole operation's duration. Both
    // possible outcomes below (push-conflict / pull results with
    // conflicts) open their OWN separate modal (repoConflictModalOpen),
    // which is unaffected by whether this modal already closed.
    close();
    try {
      const result = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      if (result.kind === "push-conflict") {
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no automated coverage touches either component directly).

- [ ] **Step 5: Manual verification**

With the `npm run dev` full stack, pick a repo in either "Open GitHub Repo as Workspace" or "Link Workspace to Repo" and confirm the modal disappears immediately, leaving only the progress toast visible while the sync runs.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/OpenRepoModal.svelte client/src/components/RepoLinkModal.svelte
git commit -m "fix: close the repo picker modal immediately instead of after the sync completes"
```

---

### Task 3: Show time since last sync

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/stores/workspaces.ts`
- Test: `client/src/stores/workspaces.test.ts`
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`
- Modify: `client/src/components/MenuBar.svelte`

**Interfaces:**
- Produces: `Workspace.repoLastSyncedAt?: number` (new optional field), `setWorkspaceLastSynced(id: string, timestamp: number): void` (new export from `./stores/workspaces`).
- Consumes (in `repo-sync.ts`): `setWorkspaceLastSynced` (new import from `./stores/workspaces`). Consumes (in `MenuBar.svelte`): `window.MDE.formatRelativeTime` (already used elsewhere in this same file, no new import needed).

- [ ] **Step 1: Write the failing store tests**

In `client/src/stores/workspaces.test.ts`, add these two tests right after the existing `"clearWorkspaceRepoLink removes repoLink from the matching workspace"` test, still inside the same `describe` block:

```ts
  it("setWorkspaceLastSynced sets repoLastSyncedAt on the matching workspace, leaves others untouched", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceLastSynced } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    const other = createWorkspace("Other");
    setWorkspaceLastSynced(ws.id, 12345);
    const all = get(workspacesStore);
    expect(all.find((w) => w.id === ws.id)?.repoLastSyncedAt).toBe(12345);
    expect(all.find((w) => w.id === other.id)?.repoLastSyncedAt).toBeUndefined();
  });

  it("clearWorkspaceRepoLink also clears repoLastSyncedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink, setWorkspaceLastSynced, clearWorkspaceRepoLink } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    setWorkspaceRepoLink(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    setWorkspaceLastSynced(ws.id, 12345);
    clearWorkspaceRepoLink(ws.id);
    expect(get(workspacesStore).find((w) => w.id === ws.id)?.repoLastSyncedAt).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/stores/workspaces.test.ts`
Expected: FAIL — `setWorkspaceLastSynced` is not exported yet.

- [ ] **Step 3: Add the field and the store function**

In `client/src/types.ts`, find:

```ts
  repoLink?: {
    owner: string;
    repo: string;
    branch: string;
  };
}
```

Change to:

```ts
  repoLink?: {
    owner: string;
    repo: string;
    branch: string;
  };
  // Set after any successful push or pull (whichever happens last) —
  // one combined "last synced" timestamp, not separate push/pull ones.
  // Meaningless without repoLink, so clearWorkspaceRepoLink clears this
  // too.
  repoLastSyncedAt?: number;
}
```

In `client/src/stores/workspaces.ts`, find:

```ts
export function clearWorkspaceRepoLink(id: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink: undefined } : w)));
  persistWorkspaces();
}
```

Change to:

```ts
export function clearWorkspaceRepoLink(id: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink: undefined, repoLastSyncedAt: undefined } : w)));
  persistWorkspaces();
}

export function setWorkspaceLastSynced(id: string, timestamp: number): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLastSyncedAt: timestamp } : w)));
  persistWorkspaces();
}
```

- [ ] **Step 4: Run store tests to verify they pass**

Run: `npx vitest run client/src/stores/workspaces.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Write the failing repo-sync tests**

In `client/src/repo-sync.test.ts`, add `workspacesStore` to the existing import (already changed by Task 1 to `import { createWorkspace, workspacesStore } from "./stores/workspaces";` — no further change needed here since Task 1 already added it).

Add these two tests inside the existing `describe("linkWorkspaceAndSync", ...)` block, after the two tests Task 1 added:

```ts
  it("sets repoLastSyncedAt after a successful push+pull", async () => {
    const ws = createWorkspace("Test Workspace 4");
    backend.seedRepo("alice", "notes", "main", []);
    const before = Date.now();

    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    const synced = get(workspacesStore).find((w) => w.id === ws.id)?.repoLastSyncedAt;
    expect(synced).toBeDefined();
    expect(synced!).toBeGreaterThanOrEqual(before);
  });
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `repoLastSyncedAt` is never set yet.

- [ ] **Step 7: Wire `setWorkspaceLastSynced` into `pushToRepo` and `pullFromRepo`**

In `client/src/repo-sync.ts`, find:

```ts
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace, renameWorkspace } from "./stores/workspaces";
```

Change to:

```ts
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace, renameWorkspace, setWorkspaceLastSynced } from "./stores/workspaces";
```

Find (in `pullFromRepo`):

```ts
  for (const create of plan.creates) await fetchAndApply(create.repoPath, create.sha);
  for (const update of plan.updates) await fetchAndApply(update.repoPath, update.sha);
  removeDocsByRepoPaths(workspaceId, plan.deletions.map((d) => d.repoPath));

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    for (const conflict of plan.conflicts) {
      if (resolutions[conflict.docId] === "theirs") await fetchAndApply(conflict.repoPath, conflict.remoteSha);
    }
  }

  return { plan, applyResolved };
}

export interface PushConflict {
```

Change to:

```ts
  for (const create of plan.creates) await fetchAndApply(create.repoPath, create.sha);
  for (const update of plan.updates) await fetchAndApply(update.repoPath, update.sha);
  removeDocsByRepoPaths(workspaceId, plan.deletions.map((d) => d.repoPath));
  setWorkspaceLastSynced(workspaceId, Date.now());

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    for (const conflict of plan.conflicts) {
      if (resolutions[conflict.docId] === "theirs") await fetchAndApply(conflict.repoPath, conflict.remoteSha);
    }
  }

  return { plan, applyResolved };
}

export interface PushConflict {
```

Find (in `pushToRepo`):

```ts
  await sendChanges(plan.changes);

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const winningDocs = plan.conflicts.filter((c) => resolutions[c.docId] === "mine").map((c) => docs.find((d) => d.id === c.docId)!);
    // sameWorkspace is unused here — the empty tree means matchedExistingFile
    // can never become true in this retry, so its value doesn't affect anything.
    const retryPlan = await planPush(winningDocs, [], true);
    await sendChanges(retryPlan.changes);
  }

  return { plan, applyResolved };
}
```

Change to:

```ts
  await sendChanges(plan.changes);
  setWorkspaceLastSynced(workspaceId, Date.now());

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const winningDocs = plan.conflicts.filter((c) => resolutions[c.docId] === "mine").map((c) => docs.find((d) => d.id === c.docId)!);
    // sameWorkspace is unused here — the empty tree means matchedExistingFile
    // can never become true in this retry, so its value doesn't affect anything.
    const retryPlan = await planPush(winningDocs, [], true);
    await sendChanges(retryPlan.changes);
  }

  return { plan, applyResolved };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 9: Display it in the GitHub Repo submenu**

In `client/src/components/MenuBar.svelte`, find:

```ts
  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const hasRepoLink = $derived(!!activeWorkspace?.repoLink);
  const repoLinkLabel = $derived(activeWorkspace?.repoLink ? `${activeWorkspace.repoLink.owner}/${activeWorkspace.repoLink.repo}` : "");
```

Change to:

```ts
  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const hasRepoLink = $derived(!!activeWorkspace?.repoLink);
  const repoLinkLabel = $derived(activeWorkspace?.repoLink ? `${activeWorkspace.repoLink.owner}/${activeWorkspace.repoLink.repo}` : "");
  const repoLastSyncedLabel = $derived(activeWorkspace?.repoLastSyncedAt ? `Synced ${window.MDE.formatRelativeTime(activeWorkspace.repoLastSyncedAt)}` : "");
```

Find:

```svelte
          {:else}
            <div class="menu-section-label">{repoLinkLabel}</div>
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pullFromRepoAction?.())}>
```

Change to:

```svelte
          {:else}
            <div class="menu-section-label">{repoLinkLabel}</div>
            {#if repoLastSyncedLabel}
              <div class="menu-section-label menu-section-sublabel">{repoLastSyncedLabel}</div>
            {/if}
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pullFromRepoAction?.())}>
```

- [ ] **Step 10: Add the sublabel style**

In `client/src/style.css`, find:

```css
.menu-section-label {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  padding: 2px 14px 6px;
}
```

Change to:

```css
.menu-section-label {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  padding: 2px 14px 6px;
}

/* Applied alongside .menu-section-label (not instead of it) on the
   repo-last-synced row — overrides the bold/uppercase/letter-spacing
   from the base rule above so it reads as a quiet timestamp, not a
   second section header. */
.menu-section-sublabel {
  margin-top: -4px;
  font-size: 11px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
  opacity: 0.75;
}
```

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 12: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 13: Manual verification**

With the `npm run dev` full stack, push or pull a linked workspace and confirm File > GitHub Repo shows a "Synced just now" (or similar) label under the repo name.

- [ ] **Step 14: Commit**

```bash
git add client/src/types.ts client/src/stores/workspaces.ts client/src/stores/workspaces.test.ts client/src/repo-sync.ts client/src/repo-sync.test.ts client/src/components/MenuBar.svelte client/src/style.css
git commit -m "feat: show time since last repo sync in the GitHub Repo submenu"
```

---

### Task 4: Consistent dropdown styling

**Files:**
- Modify: `client/src/style.css`

**Interfaces:**
- None — pure CSS addition, no markup changes at either call site (`JoinWorkspaceModal.svelte`, `RepoConflictModal.svelte`).

- [ ] **Step 1: Add the baseline select rule**

In `client/src/style.css`, find:

```css
.modal-field input {
  width: 100%;
  border: 1px solid var(--border);
  background: var(--bg-alt);
  color: var(--text);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13.5px;
}
```

Change to:

```css
.modal-field input {
  width: 100%;
  border: 1px solid var(--border);
  background: var(--bg-alt);
  color: var(--text);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13.5px;
}

/* Baseline styling for any plain <select> in the app (JoinWorkspaceModal's
   merge-target picker, RepoConflictModal's per-conflict resolution picker,
   and any future one) — excludes Share.svelte's .share-access-select/
   .share-role-select, which already have their own bespoke JS-measured-
   width styling for a different reason (see that file's own comment). */
select:not(.share-access-select):not(.share-role-select) {
  border: 1px solid var(--border);
  background: var(--bg-alt);
  color: var(--text);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13.5px;
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass (CSS-only change, no test coverage affects this).

- [ ] **Step 3: Manual verification**

With the `npm run dev` full stack, open the merge-workspace dropdown (via a shared-link join with an existing workspace present) and the repo-conflict resolution dropdown (during a push/pull conflict) and confirm both now look consistent with the rest of the app's themed inputs — border, background, radius, padding all matching, in both light and dark theme.

- [ ] **Step 4: Commit**

```bash
git add client/src/style.css
git commit -m "fix: apply consistent themed styling to plain select dropdowns"
```

---

### Task 5: Final verification

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

This needs the full `npm run dev` stack (Worker + GitHub OAuth), same as prior manual-verification steps this session:

- Link a default-named workspace ("New workspace") to a repo — confirm the sidebar shows the workspace renamed to the repo's name afterward.
- Link an already-custom-named workspace to a repo — confirm its name is unchanged.
- Pick a repo in both "Open GitHub Repo as Workspace" and "Link Workspace to Repo" — confirm the modal disappears immediately in both cases.
- After a push or pull, open File > GitHub Repo — confirm a "Synced ..." relative-time label appears under the repo name.
- Open the merge-workspace dropdown and the repo-conflict resolution dropdown — confirm both are visually consistent with the rest of the app.

If you can't run the full authenticated stack, flag this to the user rather than attempting it blind, same as the manual-verification notes on prior plans this session.
