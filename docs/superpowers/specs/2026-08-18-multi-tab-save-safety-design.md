# Multi-Tab Save Safety — Design

**TODO item:** #23's deferred piece, narrowed — "we haven't think about multi tab/window session." Scoped down (by explicit choice) to fixing the data-loss risk of having multiple tabs open at once, not the larger Google-Docs-style tab-per-document routing architecture that inspired the original note — that stays parked as a separate future project.

## Problem

The app has zero cross-tab awareness today: no `storage` event listener, no `BroadcastChannel`. `client/src/stores/docs.ts` and `client/src/stores/workspaces.ts` each load their array from `localStorage` once at module load time, then only ever update it from that tab's own actions. Every save (`persistDocs()`, `persistWorkspaces()`) does a **whole-array overwrite**: `localStorage.setItem(KEY, JSON.stringify(get(store)))`, based entirely on that tab's own (possibly stale) in-memory copy.

Concretely: open the app in two tabs, edit a local (non-shared) document in Tab A, then make *any* edit in Tab B (even to a completely different, unrelated document). Tab B's next save overwrites `localStorage` with its own stale-plus-new state, silently discarding whatever Tab A wrote — Tab A's changes are gone, with no error, no warning, and no recovery path other than Version History (if a snapshot happened to be taken before the clobber). This is a real, silent data-loss bug for local documents and workspaces, not a UX nicety.

Shared/collaborative documents are more resilient — Yjs, not `localStorage`, is their real source of truth, and it continuously re-syncs — but the local cache layer (`docsStore`'s mirror of a shared doc's content, used for the sidebar/search/etc.) isn't fully immune to the same clobbering.

## Scope

- Make it safe to have multiple tabs open at once — no silent whole-library data loss.
- Explicitly **not** in scope: the URL-per-document tab routing architecture, any "this doc is open elsewhere" UI, and what happens to the *currently open editor* if the document being edited is changed or deleted by another tab mid-session. Those remain part of the larger deferred project.

## Design

**Merge-on-save, not continuous live sync.** Before writing, each save reads the current `localStorage` state fresh and merges it with the tab's own in-memory array, record-by-record, instead of blindly overwriting. This is deliberately simpler than making all open tabs continuously mirror each other in real time (which would need care to avoid stomping on text being actively typed when a sync event arrives) — it only has to guarantee that a save never destroys a record it doesn't know it's touching.

**A shared merge utility**, `client/src/merge-records.ts`:

```ts
export function mergeById<T extends { id: string; updatedAt: number }>(current: T[], external: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of external) byId.set(item.id, item);
  for (const item of current) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}
```

Union of both sides by id; whichever has the newer `updatedAt` wins per record. **Deliberate tradeoff:** there are no tombstones, so a document deleted in Tab A can reappear if Tab B still has it in memory and saves afterward. Accepted as the right default — a resurfaced deleted record is a mildly confusing but fully recoverable surprise (delete it again), whereas silently discarding real edits (today's actual bug) is not recoverable at all. "When unsure, don't delete" over "when unsure, discard."

**`persistDocs()`** (`client/src/stores/docs.ts`) changes to read `localStorage` fresh, merge with `get(docsStore)` via `mergeById`, write the merged array back, and also `docsStore.set(merged)` — feeding the merge result back into the tab's own live UI, so it opportunistically picks up whatever another tab created or changed since this tab last loaded, as a side benefit of the fix rather than full live sync.

**`persistWorkspaces()`** (`client/src/stores/workspaces.ts`) gets the identical treatment — but `Workspace` has no `updatedAt` field today (only `createdAt`), so the merge strategy needs one added. This means:
- Adding `updatedAt: number` to the `Workspace` interface (`client/src/types.ts`).
- Backfilling it for workspaces already in storage, the same pattern already used for `Doc.createdAt` (`normalizeLoadedDocs`'s `createdAt: d.createdAt ?? d.updatedAt`) — here, `updatedAt: w.updatedAt ?? w.createdAt`.
- Bumping `updatedAt: Date.now()` in every function that mutates an existing workspace record, so the merge has an accurate freshness signal to compare. All current mutation sites, found by searching for `workspacesStore.update`:
  - `client/src/stores/workspaces.ts`: `mergeSharedWorkspaceInto`, `setWorkspaceRepoLink`, `clearWorkspaceRepoLink`, `setWorkspaceLastSynced`, `renameWorkspace`
  - `client/src/collab.ts`: the `.map()` calls inside `setAccessMode` (line 821) and `addPerson` (line 882)
- New-record creation (`createWorkspace`, `adoptSharedWorkspace`) sets `updatedAt` to the same `Date.now()` already used for `createdAt` at construction — no separate backfill needed for brand-new records.

## Testing

`mergeById` is a pure function — direct unit tests: current wins when newer, external wins when newer, a tie (equal `updatedAt`) resolves to current (matches the `>=` in the implementation), a record present only in `current` survives, a record present only in `external` survives (union), an empty `external` array returns `current` unchanged, an empty `current` array returns `external` unchanged.

`persistDocs()`/`persistWorkspaces()` are tested by seeding `localStorage` directly with an "external" array differing from the current store's in-memory state, calling the persist function, then asserting both the resulting `localStorage` contents and the store's own value reflect the expected merge — following this codebase's existing pattern of testing store modules against `localStorage` directly (see `client/src/stores/docs.test.ts`'s existing tests).

The `updatedAt`-bumping change across the workspace-mutating functions is covered by extending each function's existing tests (if present) to assert `updatedAt` increases, plus new tests for the backfill logic.
