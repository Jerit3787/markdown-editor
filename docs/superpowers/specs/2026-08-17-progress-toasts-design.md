# Progress Toasts — Design Spec

**TODO item 5.** Adds real progress visibility to the app's longest-running
user actions — GitHub repo push/pull and Gist publish — none of which
currently show anything the user can actually see while they run.

## Goal

Every long-running network operation shows a toast that updates live while
it runs (e.g. `"Pulling 3/12 files…"`), then flips to a final success or
error state and dismisses normally. Today the only in-progress feedback for
these operations is a busy-label string shown as a *menu button's own text*
(`repoSyncBusyLabel`, `gistBusyLabel`) — invisible whenever the modal that
triggered the action is open in front of that menu, which is exactly when
it matters. `gist.ts`'s image-push loop already computes a granular
`"Publishing images (X/Y)…"` count for its busy label; this spec gives that
same information (and a new equivalent for repo sync) an actually-visible
home.

## Non-goals (deferred)

- **No new UI component.** `Toast.svelte` already renders whatever's in the
  `toasts` store with no baked-in auto-dismiss animation baked into the
  component itself (dismiss timing is entirely `setTimeout`-driven from the
  store) — a toast that lives longer than usual, or has its text change in
  place, works with the existing component unmodified.
- **No real per-file progress for push.** The client sends every blob in
  one atomic request and the server builds the commit in a single round
  trip (by design — this is what avoids partial-push states on the repo).
  There's no natural per-file increment to observe from the client during
  a push, and restructuring the already-shipped push protocol to get one
  isn't worth it for a transparency-only feature. Push instead shows a
  static, still-useful count computed before sending: `"Pushing 8 files…"`.
- **No progress toast for conflict resolution.** `RepoConflictModal`'s own
  "Applying…" button state already covers that step; this spec's toasts
  cover only the initial push/pull/publish operation.
- **`repoSyncBusyLabel`/`gistBusyLabel` are untouched.** They keep
  disabling/labeling their menu buttons exactly as they do today — this
  work is additive, not a replacement.
- **The existing "gist published, but pushing images failed" secondary
  toast is untouched** — it reports a distinct partial-failure alongside
  the overall operation's own success, which is pre-existing, correct
  behavior independent of this feature.

## New toast primitive

`client/src/stores/toast.ts` gains three functions alongside the existing
`showToast`/`dismissToast`:

```ts
export function showProgressToast(message: string): number;
export function updateProgressToast(id: number, message: string): void;
export function finishProgressToast(id: number, message: string, type: ToastType, duration?: number): void;
```

- `showProgressToast` creates a toast with no auto-dismiss timer (unlike
  `showToast`) and returns its id.
- `updateProgressToast` replaces that toast's message in place. Svelte's
  keyed `{#each $toasts as t (t.id)}` in `Toast.svelte` re-renders the same
  DOM node for a message update — no flicker, no new toast appearing.
- `finishProgressToast` sets the final message/type and schedules the same
  `dismissToast` auto-removal `showToast` already uses (default 3200ms).

Every caller in this spec follows the same shape: create the toast up
front, pass an `onProgress` callback into whichever `repo-sync.ts`/
`gist.ts` function does the actual work, and finish the toast in a
try/catch around the whole operation.

## `repo-sync.ts`

`pullFromRepo` and `pushToRepo` each gain a trailing optional parameter,
purely a callback — neither function creates or owns a toast itself, both
just report messages to whoever's watching:

```ts
export async function pullFromRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  dirtyDocIds: Set<string>,
  onProgress?: (message: string) => void
): Promise<{ plan: PullPlan; applyResolved: ... }>

export async function pushToRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  onProgress?: (message: string) => void
): Promise<{ plan: PushPlan; applyResolved: ... }>
```

- `pullFromRepo`: `fetchAndApply` (already called once per created/updated
  doc) increments a `done` counter and calls
  `onProgress?.(\`Pulling ${done}/${total} file${total === 1 ? "" : "s"}…\`)`
  right before doing that file's work — `total = plan.creates.length +
  plan.updates.length`, computed once after `planPull` runs.
- `pushToRepo`: calls `onProgress?.(\`Pushing ${plan.changes.length}
  file${plan.changes.length === 1 ? "" : "s"}…\`)` once, right before
  `sendChanges`, skipped entirely when there's nothing to push
  (`plan.changes.length === 0`).

**`linkWorkspaceAndSync`** creates one toast covering both phases, passes
the same update callback into both calls, and — since a thrown error here
would otherwise leave a stale "Pushing…"/"Pulling…" toast on screen
forever — finishes the toast as an error itself before rethrowing. It does
**not** finish the toast on success, because its caller
(`RepoLinkModal.svelte`) still needs to decide between "show success" and
"conflicts found, open the resolution modal instead" — showing a premature
success message would be misleading when conflicts are still pending. The
toast's id is returned so the caller can finish it appropriately:

```ts
export interface LinkAndSyncResult {
  pullPlan: PullPlan;
  applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
  progressToastId: number;
}

export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  const progressToastId = showProgressToast("Pushing…");
  const onProgress = (message: string) => updateProgressToast(progressToastId, message);
  try {
    await pushToRepo(workspaceId, repoLink, onProgress);
    const { plan, applyResolved } = await pullFromRepo(workspaceId, repoLink, new Set(), onProgress);
    return { pullPlan: plan, applyPullResolved: applyResolved, progressToastId };
  } catch (err) {
    finishProgressToast(progressToastId, err instanceof Error ? err.message : "Sync failed", "error");
    throw err;
  }
}
```

**`createWorkspaceFromRepo`** has no equivalent conflict-routing decision
to defer — its target workspace is always brand new and empty, so
`pullFromRepo`'s plan can never contain a conflict there (no existing doc
can ever match a `repoPath`, so nothing can become an "update"). It owns
its toast fully, finishing with success or error itself:

```ts
export async function createWorkspaceFromRepo(owner: string, repo: string, branch: string): Promise<void> {
  const plan = planCreateWorkspaceFromRepo(owner, repo, branch, get(workspacesStore));
  if (plan.action === "switch") {
    if (switchWorkspace(plan.workspaceId)) ensureActiveDocInWorkspace(plan.workspaceId);
    showToast(`Switched to ${owner}/${repo}`, "success");
    return;
  }
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

The `switch` branch is instant (no network call) and gets a plain
`showToast` — it never had progress to show and still doesn't.

## `repo-sync-ui.ts`

`pullFromRepoAction`/`pushToRepoAction` (the manual File > GitHub Repo >
Pull/Push menu actions) each own their own toast directly — they're
already the outermost caller, with the same "maybe conflicts, maybe not"
decision `linkWorkspaceAndSync` has, just one layer shallower:

```ts
window.MDE.pullFromRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pulling…");
  const progressToastId = showProgressToast("Pulling…");
  try {
    const { plan, applyResolved } = await pullFromRepo(active.workspaceId, active.repoLink, new Set(), (message) =>
      updateProgressToast(progressToastId, message)
    );
    if (plan.conflicts.length > 0 || plan.deletions.length > 0) {
      dismissToast(progressToastId);
      repoConflictState.set({ /* ...unchanged... */ });
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

`pushToRepoAction` follows the identical shape, replacing its existing
`showToast("Pushed to repo", "success")` / `showToast(err.message || "Push
failed", "error")` calls with `finishProgressToast`, and its conflict
branch dismisses the progress toast the same way before opening
`repoConflictModal`.

## `RepoLinkModal.svelte` / `OpenRepoModal.svelte`

Both modals' final `showToast(...)` calls for the success/error paths
become redundant once `linkWorkspaceAndSync`/`createWorkspaceFromRepo` own
that messaging themselves — removed to avoid a double toast. `RepoLinkModal`
additionally needs to finish (success) or dismiss (conflicts) the toast id
`linkWorkspaceAndSync` now returns:

```ts
async function linkWorkspace(owner: string, repo: string, branch: string) {
  const workspaceId = $activeWorkspaceIdStore;
  if (!workspaceId) return;
  try {
    const { pullPlan, applyPullResolved, progressToastId } = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
    close();
    if (pullPlan.conflicts.length > 0 || pullPlan.deletions.length > 0) {
      dismissToast(progressToastId);
      repoConflictState.set({ /* ...unchanged... */ });
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

`OpenRepoModal.svelte`'s `pickRepo` simply drops its own `showToast` calls
— `createWorkspaceFromRepo` now shows success/error/switch feedback
itself:

```ts
async function pickRepo(owner: string, repo: string, branch: string) {
  try {
    await createWorkspaceFromRepo(owner, repo, branch);
    close();
  } catch (err: any) {
    // createWorkspaceFromRepo already finished its progress toast as an
    // error — nothing left to show here.
  }
}
```

## `gist.ts`

`publish()` creates a progress toast alongside its existing
`gistBusyLabel.set(...)` calls, and `pushImagesAndRewrite` gains the same
`onProgress` callback pattern used in `repo-sync.ts`:

```ts
async function pushImagesAndRewrite(
  gistId: string,
  rawContent: string,
  images: Record<string, string> | undefined,
  onProgress?: (message: string) => void
): Promise<string | null> {
  // ...
  for (const [src, dataUrl] of sources) {
    done++;
    const message = `Publishing images (${done}/${sources.size})…`;
    gistBusyLabel.set(message);
    onProgress?.(message);
    // ...unchanged...
  }
  // ...
}
```

In `publish()`: create `const progressToastId = showProgressToast(wasUpdate
? "Updating…" : "Publishing…");` right next to the existing
`gistBusyLabel.set(...)` call. Replace:
- The "gist no longer exists" 404 branch's `showToast(...)` with
  `finishProgressToast(progressToastId, "That Gist no longer exists —
  publish again to create a new one.", "error")`.
- The image-rewrite call: pass `(message) =>
  updateProgressToast(progressToastId, message)` as `pushImagesAndRewrite`'s
  new fourth argument.
- The final success `showToast(...)` with `finishProgressToast(progressToastId,
  wasUpdate ? "Gist updated" : "Published to Gist", "success")`.
- The outer catch's `showToast(...)` with `finishProgressToast(progressToastId,
  \`Failed to publish: ${err.message || "unknown error"}\`, "error")`.

The inner `catch (imgErr)` block (partial failure — gist published fine,
image push failed) keeps its own separate `showToast` unchanged, per
Non-goals above.

## Testing

- Unit tests for the three new `stores/toast.ts` functions: `showProgressToast`
  adds a toast with no scheduled removal; `updateProgressToast` replaces an
  existing toast's message without changing its id or type; `finishProgressToast`
  updates message/type and the toast is gone from the store after its
  duration elapses (`vi.useFakeTimers()` + `vi.advanceTimersByTime`, matching
  patterns already usable in this codebase's Vitest setup).
- No changes needed to `client/src/repo-sync.test.ts`'s existing
  `linkWorkspaceAndSync` integration tests structurally — `onProgress` is
  optional and unused by those tests, and the returned `LinkAndSyncResult`
  gains a field (`progressToastId`) without removing any existing one, so
  the existing assertions on `pullPlan`/`applyPullResolved` keep passing
  unmodified. Optionally add one new assertion there that `progressToastId`
  is a number, to lock in the shape.
- No automated test for `RepoLinkModal.svelte`/`OpenRepoModal.svelte`
  (this codebase has no Svelte component tests, per the precedent already
  established in the doc-info-adjustments work) — manual verification:
  trigger each of the four flows (manual Pull, manual Push, Link Workspace,
  Open Repo as Workspace) against a repo with a few files and confirm a
  toast appears, updates its text at least once during the operation, and
  settles into a final success message that then dismisses itself.
