# Progress Toasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app's longest-running operations (GitHub repo push/pull, Gist publish) a toast that updates live while they run, instead of the only feedback being a menu button's own label — invisible whenever the modal that triggered the action is on top of that menu.

**Architecture:** Three new functions on the existing `stores/toast.ts` (`showProgressToast`/`updateProgressToast`/`finishProgressToast`) reuse `Toast.svelte` unmodified — it already renders whatever's in the `toasts` store with no baked-in dismiss animation. `pullFromRepo`/`pushToRepo` (`repo-sync.ts`) and `pushImagesAndRewrite` (`gist.ts`) gain an optional `onProgress` callback parameter — they report messages, they never own a toast themselves. Every actual call site (the four repo-sync entry points, `gist.ts`'s `publish()`) creates its own toast, wires the callback into it, and finishes the toast in a try/catch around the whole operation.

**Tech Stack:** TypeScript, Svelte 5, Vitest.

## Global Constraints

- `pullFromRepo`'s progress message: `` `Pulling ${done}/${total} file${total === 1 ? "" : "s"}…` ``, `done` incremented right before each file's work starts, `total = plan.creates.length + plan.updates.length`.
- `pushToRepo`'s progress message: `` `Pushing ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}…` ``, reported once before `sendChanges`, skipped when `plan.changes.length === 0`.
- `repoSyncBusyLabel`/`gistBusyLabel` are untouched — every change here is additive alongside them, never a replacement.
- No progress toast for conflict resolution (`RepoConflictModal`'s own "Applying…" button state already covers that step) — only the initial push/pull/publish operation gets one.
- The existing "gist published, but pushing images failed" secondary `showToast` in `gist.ts` stays exactly as it is.
- `linkWorkspaceAndSync` never finishes its toast with success itself (only on error, before rethrowing) — its caller (`RepoLinkModal.svelte`) owns the success-vs-conflicts decision and must finish or dismiss the toast accordingly.

---

### Task 1: Progress toast primitives

**Files:**
- Modify: `client/src/stores/toast.ts`
- Test: `client/src/stores/toast.test.ts` (new file)

**Interfaces:**
- Produces:
  ```ts
  export function showProgressToast(message: string): number;
  export function updateProgressToast(id: number, message: string): void;
  export function finishProgressToast(id: number, message: string, type: ToastType, duration?: number): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `client/src/stores/toast.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { toasts, showProgressToast, updateProgressToast, finishProgressToast } from "./toast";

describe("progress toasts", () => {
  beforeEach(() => {
    toasts.set([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("showProgressToast adds a toast with no scheduled auto-removal", () => {
    const id = showProgressToast("Pushing…");
    expect(get(toasts)).toEqual([{ id, message: "Pushing…", type: "info" }]);
    vi.advanceTimersByTime(60000);
    expect(get(toasts)).toEqual([{ id, message: "Pushing…", type: "info" }]);
  });

  it("updateProgressToast replaces the message in place, keeping id and type", () => {
    const id = showProgressToast("Pushing…");
    updateProgressToast(id, "Pushing 3/8 files…");
    expect(get(toasts)).toEqual([{ id, message: "Pushing 3/8 files…", type: "info" }]);
  });

  it("finishProgressToast sets the final message/type, then it's gone after its duration", () => {
    const id = showProgressToast("Pushing…");
    finishProgressToast(id, "Pushed to repo", "success", 1000);
    expect(get(toasts)).toEqual([{ id, message: "Pushed to repo", type: "success" }]);
    vi.advanceTimersByTime(999);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(get(toasts)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/stores/toast.test.ts`
Expected: FAIL — `showProgressToast`/`updateProgressToast`/`finishProgressToast` aren't exported yet.

- [ ] **Step 3: Write the implementation**

Replace the full contents of `client/src/stores/toast.ts` with:

```ts
// Toasts for actions that were previously silent (or only visible as a
// transient inline label swap) — doc duplicate/delete, share/access
// changes, publish/export, and surfacing failures that used to fail
// quietly. Any file can call showToast(); Toast.svelte (mounted once at
// app root) is the only thing that reads the store.
import { writable } from "svelte/store";

export type ToastType = "success" | "error" | "info";

export interface ToastMsg {
  id: number;
  message: string;
  type: ToastType;
}

export const toasts = writable<ToastMsg[]>([]);

let nextId = 1;

export function showToast(message: string, type: ToastType = "info", duration = 3200) {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, type }]);
  setTimeout(() => dismissToast(id), duration);
}

export function dismissToast(id: number) {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

// The three functions below back a single toast that stays on screen and
// updates its own text while a long-running operation (repo push/pull,
// Gist publish) is in flight — showToast's fixed short duration and
// one-shot message don't fit that. Toast.svelte needs no changes to
// support this: it just renders whatever's in `toasts`, keyed by id, so
// updating an existing entry's message re-renders that same toast in
// place rather than creating a new one.
export function showProgressToast(message: string): number {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, type: "info" }]);
  return id;
}

export function updateProgressToast(id: number, message: string) {
  toasts.update((list) => list.map((t) => (t.id === id ? { ...t, message } : t)));
}

export function finishProgressToast(id: number, message: string, type: ToastType, duration = 3200) {
  toasts.update((list) => list.map((t) => (t.id === id ? { ...t, message, type } : t)));
  setTimeout(() => dismissToast(id), duration);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/stores/toast.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/toast.ts client/src/stores/toast.test.ts
git commit -m "feat: add progress toast primitives"
```

---

### Task 2: Wire `repo-sync.ts`

**Files:**
- Modify: `client/src/repo-sync.ts`
- Modify: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `showProgressToast`/`updateProgressToast`/`finishProgressToast` (Task 1, `./stores/toast`).
- Produces:
  ```ts
  export async function pullFromRepo(
    workspaceId: string,
    repoLink: { owner: string; repo: string; branch: string },
    dirtyDocIds: Set<string>,
    onProgress?: (message: string) => void
  ): Promise<{ plan: PullPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }>;

  export async function pushToRepo(
    workspaceId: string,
    repoLink: { owner: string; repo: string; branch: string },
    onProgress?: (message: string) => void
  ): Promise<{ plan: PushPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }>;

  export interface LinkAndSyncResult {
    pullPlan: PullPlan;
    applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
    progressToastId: number;
  }
  export async function linkWorkspaceAndSync(
    workspaceId: string,
    repoLink: { owner: string; repo: string; branch: string }
  ): Promise<LinkAndSyncResult>;

  export async function createWorkspaceFromRepo(owner: string, repo: string, branch: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

In `client/src/repo-sync.test.ts`, find this block (inside `describe("linkWorkspaceAndSync", ...)`):

```ts
    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(2);

    const localDoc = docs.find((d) => d.id === "local-1")!;
    expect(localDoc.repoPath).toBeDefined();
    expect(localDoc.repoSha).toBeDefined();

    const pulledDoc = docs.find((d) => d.repoPath === "existing.md");
    expect(pulledDoc).toBeDefined();
    expect(pulledDoc!.content).toBe("pre-existing");
  });
```

Change it to:

```ts
    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    expect(typeof result.progressToastId).toBe("number");

    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(2);

    const localDoc = docs.find((d) => d.id === "local-1")!;
    expect(localDoc.repoPath).toBeDefined();
    expect(localDoc.repoSha).toBeDefined();

    const pulledDoc = docs.find((d) => d.repoPath === "existing.md");
    expect(pulledDoc).toBeDefined();
    expect(pulledDoc!.content).toBe("pre-existing");
  });
```

Find this line (the second `linkWorkspaceAndSync` test):

```ts
    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    expect(result.pullPlan.conflicts).toEqual([]);
```

Change it to:

```ts
    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    expect(typeof result.progressToastId).toBe("number");
    expect(result.pullPlan.conflicts).toEqual([]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `result.progressToastId` is `undefined`, not a number.

- [ ] **Step 3: Write the implementation**

In `client/src/repo-sync.ts`, add a new import below the existing ones:

```ts
import { showProgressToast, updateProgressToast, finishProgressToast, showToast } from "./stores/toast";
```

Change the `pullFromRepo` signature and its `fetchAndApply` usage. Find:

```ts
export async function pullFromRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  dirtyDocIds: Set<string>
): Promise<{ plan: PullPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = planPull(entries, docs, dirtyDocIds);

  const docSlugFor = (repoPath: string) => repoPath.replace(/\.md$/i, "").split("/").pop() || "untitled";

  async function fetchAndApply(repoPath: string, sha: string): Promise<void> {
    const blobRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/blob/${sha}`);
```

Change to:

```ts
export async function pullFromRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  dirtyDocIds: Set<string>,
  onProgress?: (message: string) => void
): Promise<{ plan: PullPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = planPull(entries, docs, dirtyDocIds);
  const total = plan.creates.length + plan.updates.length;
  let done = 0;

  const docSlugFor = (repoPath: string) => repoPath.replace(/\.md$/i, "").split("/").pop() || "untitled";

  async function fetchAndApply(repoPath: string, sha: string): Promise<void> {
    done++;
    onProgress?.(`Pulling ${done}/${total} file${total === 1 ? "" : "s"}…`);
    const blobRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/blob/${sha}`);
```

Change the `pushToRepo` signature and add the progress call before `sendChanges`. Find:

```ts
export async function pushToRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<{ plan: PushPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = await planPush(docs, entries);
```

Change to:

```ts
export async function pushToRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  onProgress?: (message: string) => void
): Promise<{ plan: PushPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = await planPush(docs, entries);
  if (plan.changes.length > 0) {
    onProgress?.(`Pushing ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}…`);
  }
```

Change `createWorkspaceFromRepo`. Find:

```ts
export async function createWorkspaceFromRepo(owner: string, repo: string, branch: string): Promise<void> {
  const plan = planCreateWorkspaceFromRepo(owner, repo, branch, get(workspacesStore));
  if (plan.action === "switch") {
    if (switchWorkspace(plan.workspaceId)) ensureActiveDocInWorkspace(plan.workspaceId);
    return;
  }
  // createWorkspace() already switches activeWorkspaceIdStore to the new
  // workspace — but the active *document* still points at whatever was
  // open in the previous workspace until ensureActiveDocInWorkspace runs
  // below, once the workspace actually has documents to land on.
  const ws = createWorkspace(plan.workspaceName);
  setWorkspaceRepoLink(ws.id, { owner, repo, branch });
  await pullFromRepo(ws.id, { owner, repo, branch }, new Set());
  ensureActiveDocInWorkspace(ws.id);
}
```

Change to:

```ts
export async function createWorkspaceFromRepo(owner: string, repo: string, branch: string): Promise<void> {
  const plan = planCreateWorkspaceFromRepo(owner, repo, branch, get(workspacesStore));
  if (plan.action === "switch") {
    if (switchWorkspace(plan.workspaceId)) ensureActiveDocInWorkspace(plan.workspaceId);
    showToast(`Switched to ${owner}/${repo}`, "success");
    return;
  }
  // createWorkspace() already switches activeWorkspaceIdStore to the new
  // workspace — but the active *document* still points at whatever was
  // open in the previous workspace until ensureActiveDocInWorkspace runs
  // below, once the workspace actually has documents to land on.
  const ws = createWorkspace(plan.workspaceName);
  setWorkspaceRepoLink(ws.id, { owner, repo, branch });
  const progressToastId = showProgressToast("Pulling…");
  try {
    await pullFromRepo(ws.id, { owner, repo, branch }, new Set(), (message) => updateProgressToast(progressToastId, message));
    ensureActiveDocInWorkspace(ws.id);
    finishProgressToast(progressToastId, `Opened ${owner}/${repo}`, "success");
  } catch (err) {
    finishProgressToast(progressToastId, err instanceof Error ? err.message : "Couldn't open that repo", "error");
    throw err;
  }
}
```

Change `linkWorkspaceAndSync` and `LinkAndSyncResult`. Find:

```ts
export interface LinkAndSyncResult {
  pullPlan: PullPlan;
  applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
}

// Push conflicts can never happen here: clearRepoSyncMetadata (above)
// strips every doc's repoPath first, and planPush only ever raises a
// conflict when a doc already has one — so the push step's own plan is
// safe to discard. Pull conflicts, on the other hand, are possible (the
// tree could move between the push and pull calls below) and are
// returned to the caller to route through the shared repoConflictModal,
// exactly like the manual "Pull from Repo" action already does.
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  repoSyncBusyLabel.set("Pushing…");
  await pushToRepo(workspaceId, repoLink);
  repoSyncBusyLabel.set("Pulling…");
  const { plan, applyResolved } = await pullFromRepo(workspaceId, repoLink, new Set());
  return { pullPlan: plan, applyPullResolved: applyResolved };
}
```

Change to:

```ts
export interface LinkAndSyncResult {
  pullPlan: PullPlan;
  applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
  progressToastId: number;
}

// Push conflicts can never happen here: clearRepoSyncMetadata (above)
// strips every doc's repoPath first, and planPush only ever raises a
// conflict when a doc already has one — so the push step's own plan is
// safe to discard. Pull conflicts, on the other hand, are possible (the
// tree could move between the push and pull calls below) and are
// returned to the caller to route through the shared repoConflictModal,
// exactly like the manual "Pull from Repo" action already does.
//
// The returned toast is never finished with success here — only ever
// with an error, before rethrowing, so a thrown failure never leaves a
// stale "Pushing…"/"Pulling…" toast on screen. The success case is the
// caller's call: it still has to decide between "show success" and
// "conflicts found, open the resolution modal instead," and finishing
// this toast with a premature success message would be misleading in
// the second case.
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  repoSyncBusyLabel.set("Pushing…");
  const progressToastId = showProgressToast("Pushing…");
  const onProgress = (message: string) => updateProgressToast(progressToastId, message);
  try {
    await pushToRepo(workspaceId, repoLink, onProgress);
    repoSyncBusyLabel.set("Pulling…");
    const { plan, applyResolved } = await pullFromRepo(workspaceId, repoLink, new Set(), onProgress);
    return { pullPlan: plan, applyPullResolved: applyResolved, progressToastId };
  } catch (err) {
    finishProgressToast(progressToastId, err instanceof Error ? err.message : "Sync failed", "error");
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: wire progress toasts into repo-sync.ts"
```

---

### Task 3: Wire the repo-sync UI call sites

**Files:**
- Modify: `client/src/repo-sync-ui.ts`
- Modify: `client/src/components/RepoLinkModal.svelte`
- Modify: `client/src/components/OpenRepoModal.svelte`

**Interfaces:**
- Consumes: `showProgressToast`/`updateProgressToast`/`finishProgressToast`/`dismissToast` (Task 1); `pullFromRepo`/`pushToRepo`'s new `onProgress` parameter and `linkWorkspaceAndSync`'s new `progressToastId` field (Task 2).

- [ ] **Step 1: Wire `repo-sync-ui.ts`**

Change the import from `./stores/toast`. Find:

```ts
import { showToast } from "./stores/toast";
```

Change to (`showToast` is dropped — after this task's edits it has no remaining callers in this file, both of its previous call sites become `finishProgressToast` below):

```ts
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast } from "./stores/toast";
```

Find `window.MDE.pullFromRepoAction`:

```ts
window.MDE.pullFromRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pulling…");
  try {
    // No local dirty-tracking timestamp exists yet at this call site —
    // pass an empty set, meaning "treat every doc as clean," which is
    // conservative in the wrong direction (a genuinely-dirty doc could
    // get silently overwritten by an update instead of flagged as a
    // conflict). Acceptable for now since it still routes every conflict
    // planPull *can* detect through the modal; tightening this to real
    // dirty-tracking is a follow-up, not a blocker.
    const { plan, applyResolved } = await pullFromRepo(active.workspaceId, active.repoLink, new Set());
    if (plan.conflicts.length > 0 || plan.deletions.length > 0) {
      repoConflictState.set({
        kind: "pull",
        conflicts: plan.conflicts.map((c: PullConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: plan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(active.workspaceId, d.docId), repoPath: d.repoPath })),
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      showToast("Pulled from repo", "success");
    }
  } catch (err: any) {
    showToast(err.message || "Pull failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};
```

Change to:

```ts
window.MDE.pullFromRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pulling…");
  const progressToastId = showProgressToast("Pulling…");
  try {
    // No local dirty-tracking timestamp exists yet at this call site —
    // pass an empty set, meaning "treat every doc as clean," which is
    // conservative in the wrong direction (a genuinely-dirty doc could
    // get silently overwritten by an update instead of flagged as a
    // conflict). Acceptable for now since it still routes every conflict
    // planPull *can* detect through the modal; tightening this to real
    // dirty-tracking is a follow-up, not a blocker.
    const { plan, applyResolved } = await pullFromRepo(active.workspaceId, active.repoLink, new Set(), (message) =>
      updateProgressToast(progressToastId, message)
    );
    if (plan.conflicts.length > 0 || plan.deletions.length > 0) {
      dismissToast(progressToastId);
      repoConflictState.set({
        kind: "pull",
        conflicts: plan.conflicts.map((c: PullConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: plan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(active.workspaceId, d.docId), repoPath: d.repoPath })),
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      finishProgressToast(progressToastId, "Pulled from repo", "success");
    }
  } catch (err: any) {
    finishProgressToast(progressToastId, err.message || "Pull failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};
```

Find `window.MDE.pushToRepoAction`:

```ts
window.MDE.pushToRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pushing…");
  try {
    const { plan, applyResolved } = await pushToRepo(active.workspaceId, active.repoLink);
    if (plan.conflicts.length > 0) {
      repoConflictState.set({
        kind: "push",
        conflicts: plan.conflicts.map((c: PushConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: [],
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      showToast("Pushed to repo", "success");
    }
  } catch (err: any) {
    showToast(err.message || "Push failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};
```

Change to:

```ts
window.MDE.pushToRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pushing…");
  const progressToastId = showProgressToast("Pushing…");
  try {
    const { plan, applyResolved } = await pushToRepo(active.workspaceId, active.repoLink, (message) => updateProgressToast(progressToastId, message));
    if (plan.conflicts.length > 0) {
      dismissToast(progressToastId);
      repoConflictState.set({
        kind: "push",
        conflicts: plan.conflicts.map((c: PushConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: [],
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      finishProgressToast(progressToastId, "Pushed to repo", "success");
    }
  } catch (err: any) {
    finishProgressToast(progressToastId, err.message || "Push failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};
```

- [ ] **Step 2: Wire `RepoLinkModal.svelte`**

Change the import from `../stores/repoSync` and `../stores/toast`. Find:

```svelte
  import { repoLinkModalOpen, repoSyncBusyLabel, repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { activeWorkspaceIdStore } from "../stores/workspaces";
  import { docsInWorkspace } from "../stores/docs";
  import { linkWorkspaceAndSync } from "../repo-sync";
  import { showToast } from "../stores/toast";
```

Change to:

```svelte
  import { repoLinkModalOpen, repoSyncBusyLabel, repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { activeWorkspaceIdStore } from "../stores/workspaces";
  import { docsInWorkspace } from "../stores/docs";
  import { linkWorkspaceAndSync } from "../repo-sync";
  import { finishProgressToast, dismissToast } from "../stores/toast";
```

Find `linkWorkspace`:

```svelte
  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    try {
      const { pullPlan, applyPullResolved } = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      close();
      if (pullPlan.conflicts.length > 0 || pullPlan.deletions.length > 0) {
        repoConflictState.set({
          kind: "pull",
          conflicts: pullPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: pullPlan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(workspaceId, d.docId), repoPath: d.repoPath })),
          onResolve: applyPullResolved,
        });
        repoConflictModalOpen.set(true);
      } else {
        showToast(`Linked to ${owner}/${repo}`, "success");
      }
    } catch (err: any) {
      showToast(err.message || "Couldn't sync after linking", "error");
    } finally {
      repoSyncBusyLabel.set(null);
    }
  }
```

Change to:

```svelte
  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    try {
      const { pullPlan, applyPullResolved, progressToastId } = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      close();
      if (pullPlan.conflicts.length > 0 || pullPlan.deletions.length > 0) {
        dismissToast(progressToastId);
        repoConflictState.set({
          kind: "pull",
          conflicts: pullPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: pullPlan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(workspaceId, d.docId), repoPath: d.repoPath })),
          onResolve: applyPullResolved,
        });
        repoConflictModalOpen.set(true);
      } else {
        finishProgressToast(progressToastId, `Linked to ${owner}/${repo}`, "success");
      }
    } catch (err: any) {
      // linkWorkspaceAndSync already finished the progress toast as an
      // error before rethrowing — nothing left to show here.
    } finally {
      repoSyncBusyLabel.set(null);
    }
  }
```

- [ ] **Step 3: Wire `OpenRepoModal.svelte`**

Find:

```svelte
  import { openRepoModalOpen } from "../stores/repoSync";
  import { createWorkspaceFromRepo } from "../repo-sync";
  import { showToast } from "../stores/toast";

  function close() {
    openRepoModalOpen.set(false);
  }

  async function pickRepo(owner: string, repo: string, branch: string) {
    try {
      await createWorkspaceFromRepo(owner, repo, branch);
      close();
      showToast(`Opened ${owner}/${repo}`, "success");
    } catch (err: any) {
      showToast(err.message || "Couldn't open that repo", "error");
    }
  }
```

Change to:

```svelte
  import { openRepoModalOpen } from "../stores/repoSync";
  import { createWorkspaceFromRepo } from "../repo-sync";

  function close() {
    openRepoModalOpen.set(false);
  }

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

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Manual verification**

Run the dev server (`npm run dev:client`). This flow needs a real GitHub session for the actual network calls to succeed (`requireRepoScope()` gates every entry point) — trigger each of the four flows against a real linked repo with at least 2-3 `.md` files and confirm a toast appears, its text updates during the operation (most visibly for Pull, which increments per file), and it settles into a final success message that dismisses itself after ~3 seconds:
  1. File > GitHub Repo > Pull from Repo
  2. File > GitHub Repo > Push to Repo
  3. File > GitHub Repo > Link Workspace to Repo... (pick a repo with existing content)
  4. File > Open > From GitHub Repo... (pick a repo with existing content)

- [ ] **Step 7: Commit**

```bash
git add client/src/repo-sync-ui.ts client/src/components/RepoLinkModal.svelte client/src/components/OpenRepoModal.svelte
git commit -m "feat: wire progress toasts into repo-sync menu/modal actions"
```

---

### Task 4: Wire Gist publish

**Files:**
- Modify: `client/src/gist.ts`

**Interfaces:**
- Consumes: `showProgressToast`/`updateProgressToast`/`finishProgressToast` (Task 1, `./stores/toast`).

- [ ] **Step 1: Add the import**

Find:

```ts
import { showToast } from "./stores/toast";
```

Change to:

```ts
import { showToast, showProgressToast, updateProgressToast, finishProgressToast } from "./stores/toast";
```

- [ ] **Step 2: Wire `pushImagesAndRewrite`**

Find:

```ts
async function pushImagesAndRewrite(
  gistId: string,
  rawContent: string,
  images: Record<string, string> | undefined
): Promise<string | null> {
```

Change to:

```ts
async function pushImagesAndRewrite(
  gistId: string,
  rawContent: string,
  images: Record<string, string> | undefined,
  onProgress?: (message: string) => void
): Promise<string | null> {
```

Find:

```ts
  for (const [src, dataUrl] of sources) {
    done++;
    gistBusyLabel.set(`Publishing images (${done}/${sources.size})…`);
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/);
```

Change to:

```ts
  for (const [src, dataUrl] of sources) {
    done++;
    const message = `Publishing images (${done}/${sources.size})…`;
    gistBusyLabel.set(message);
    onProgress?.(message);
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/);
```

- [ ] **Step 3: Wire `publish()`**

Find:

```ts
  const wasUpdate = !!doc.gistId;
  gistBusyLabel.set(wasUpdate ? "Updating…" : "Publishing…");

  try {
```

Change to:

```ts
  const wasUpdate = !!doc.gistId;
  gistBusyLabel.set(wasUpdate ? "Updating…" : "Publishing…");
  const progressToastId = showProgressToast(wasUpdate ? "Updating…" : "Publishing…");

  try {
```

Find:

```ts
        clearActiveDocGist();
        window.MDE.refreshSaveStatus();
        gistBusyLabel.set("Failed: Gist no longer exists");
        showToast("That Gist no longer exists — publish again to create a new one.", "error");
        return;
```

Change to:

```ts
        clearActiveDocGist();
        window.MDE.refreshSaveStatus();
        gistBusyLabel.set("Failed: Gist no longer exists");
        finishProgressToast(progressToastId, "That Gist no longer exists — publish again to create a new one.", "error");
        return;
```

Find:

```ts
    try {
      const rewritten = await pushImagesAndRewrite(gistId, rawContent, doc.images);
      if (rewritten) {
```

Change to:

```ts
    try {
      const rewritten = await pushImagesAndRewrite(gistId, rawContent, doc.images, (message) => updateProgressToast(progressToastId, message));
      if (rewritten) {
```

Find:

```ts
    gistBusyLabel.set(wasUpdate ? "Updated ✓" : "Published ✓");
    window.MDE.refreshSaveStatus();
    showToast(wasUpdate ? "Gist updated" : "Published to Gist", "success");
  } catch (err: any) {
    gistBusyLabel.set(`Failed: ${err.message || "unknown error"}`);
    showToast(`Failed to publish: ${err.message || "unknown error"}`, "error");
  } finally {
    setTimeout(() => gistBusyLabel.set(null), 2000);
  }
```

Change to:

```ts
    gistBusyLabel.set(wasUpdate ? "Updated ✓" : "Published ✓");
    window.MDE.refreshSaveStatus();
    finishProgressToast(progressToastId, wasUpdate ? "Gist updated" : "Published to Gist", "success");
  } catch (err: any) {
    gistBusyLabel.set(`Failed: ${err.message || "unknown error"}`);
    finishProgressToast(progressToastId, `Failed to publish: ${err.message || "unknown error"}`, "error");
  } finally {
    setTimeout(() => gistBusyLabel.set(null), 2000);
  }
```

The inner `catch (imgErr: any) { showToast(...) }` block (partial failure — gist published, image push failed) stays exactly as it is; it reports a distinct secondary problem alongside the operation's own success/failure and isn't part of this feature.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Manual verification**

Run the dev server. Publish a document with at least 2-3 images to a new Gist (or update an existing one) — confirm a progress toast appears, updates through `"Publishing images (1/3)…"` etc., and settles into "Published to Gist" / "Gist updated".

- [ ] **Step 7: Commit**

```bash
git add client/src/gist.ts
git commit -m "feat: wire progress toasts into Gist publish"
```

---

### Task 5: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including the 3 new toast-primitive tests from Task 1.

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
