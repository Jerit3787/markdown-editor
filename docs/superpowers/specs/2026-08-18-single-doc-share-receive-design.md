# Single-Document Share Receive UX — Design

**TODO item:** #23 (narrowed scope) — "the issue is handling single file/docs sharing. Should it be that, the single file opens in a new workspace or not." Only this sub-question is addressed here. The multi-tab/window "one document per session" architecture mentioned in the same TODO item remains parked as a separate future project.

## Problem

Sharing a single document already moves it into its own dedicated workspace (named after the document) and shares that (`collab.ts`'s `openShareModal`/`decideShareTarget`) — so mechanically, a "single-doc share" link is always a workspace-share link for a workspace that happens to have one document.

Item 22 already fixed the *zero-workspace* receiver case: someone with no workspaces at all who opens any share link skips straight to adopting it, no modal. But an **existing** user (already has at least one workspace) gets the exact same "Join shared workspace" modal (`JoinWorkspaceModal.svelte`) regardless of whether the shared workspace has 1 document or 50 — there's no special-casing by document count today. For a single document, that modal's "merge into an existing workspace, or add as new?" choice is a decision with no real substance behind it — there's nothing to weigh a lone document's placement against.

Separately (found during investigation, not the original ask, but load-bearing for this design): the modal and the zero-workspace auto-adopt path both hardcode the new workspace's name as the literal string `"Shared workspace"` — never the real name — because the receiver has no way to look it up (the server stores no workspace name at all, only docs and access records). Left as-is, this design's "skip the modal, always create a new workspace" approach would mean a user who receives several single-doc shares over time ends up with multiple sidebar entries all identically named "Shared workspace," indistinguishable from each other.

## Scope

- `client/src/collab.ts`'s `joinSharedLink` (the receive-side handler for `/w/<workspaceId>/<docId>/<mode>` links) and its decision logic only.
- Fixes the "Shared workspace" naming gap **for the single-doc case only**, using data already available client-side (no backend change): the doc's real name, already fetched into `validDocs` before any decision is made, and known accurate because the sender named the workspace after the document when creating a single-doc share in the first place.
- The same naming gap for a genuine multi-doc workspace share (no single obvious name to substitute) is out of scope — pre-existing behavior, unchanged.
- `JoinWorkspaceModal.svelte` itself is unchanged — it still exists and still handles the genuine multi-doc case exactly as today.

## Design

**New pure, exported decision function in `collab.ts`**, mirroring the existing sender-side `decideShareTarget` (same file, same pattern — a pure function the orchestrating code calls and branches on):

```ts
export type JoinDecision = { kind: "auto"; workspaceName: string } | { kind: "choice" };

// A single shared document is unambiguous — there's nothing to meaningfully
// choose between (merge one document into an existing workspace, or give it
// its own?) — so it always lands as its own new workspace, named after the
// document, regardless of how many workspaces the receiver already has.
// A multi-document workspace share still gets a real choice, except for a
// receiver with zero workspaces, who — per item 22 — has nothing to choose
// between either.
export function decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number): JoinDecision {
  if (validDocs.length === 1) return { kind: "auto", workspaceName: validDocs[0]!.name || "Untitled" };
  if (existingWorkspaceCount === 0) return { kind: "auto", workspaceName: "Shared workspace" };
  return { kind: "choice" };
}
```

The `"Untitled"` fallback matches the exact convention `decideShareTarget` already uses sender-side (`doc.name || "Untitled"`) for symmetry.

**`joinSharedLink` calls it** in place of today's separate "single-doc" and "zero-workspace" checks (there is no separate single-doc check today — this replaces the existing zero-workspace-only check with one that also covers the single-doc case):

```ts
const docIds = await fetchWorkspaceDocIds(workspaceId);
const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
const validDocs = docs.filter((d): d is NonNullable<typeof d> => !!d);

const decision = decideJoinTarget(validDocs, get(workspacesStore).length);
if (decision.kind === "auto") {
  const ws = adoptSharedWorkspace(workspaceId, decision.workspaceName);
  importRemoteDocs(ws.id, validDocs);
  switchWorkspace(ws.id);
  switchDoc(landOnDocId);
  return;
}

pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: validDocs, landOnDocId });
```

The `localMatch` branch above this (already-joined-before check) and the modal path below it (`pendingJoin`) are both unchanged.

## Edge case

This is doc-count-based, not intent-based: if a sender's original 2-document share later has one document deleted, a receiver opening that link afterward sees 1 valid document and gets the auto-new-workspace treatment, even though the sender never explicitly chose "share as single document." This is treated as correct, not a bug — a 1-document result carries the same "nothing to choose between" reasoning regardless of how it got to be 1 document.

## Testing

`decideJoinTarget` is a pure function — direct unit tests, following the existing `decideShareTarget` test pattern in `client/src/collab.test.ts`:
- A single valid doc → `{ kind: "auto", workspaceName: <that doc's name> }`, regardless of `existingWorkspaceCount` (test at least one case with 0 and one with >0 to confirm doc count wins over workspace count).
- A single valid doc with an empty name → `workspaceName: "Untitled"`.
- Multiple valid docs, zero existing workspaces → `{ kind: "auto", workspaceName: "Shared workspace" }`.
- Multiple valid docs, at least one existing workspace → `{ kind: "choice" }`.

`joinSharedLink` itself remains untested (async, DOM/module-state-coupled orchestration — same boundary the codebase already draws around `openShareModal`, which calls `decideShareTarget` but is itself untested). No live browser verification for the wiring change: `joinSharedLink` fetches document content via `fetchRemoteDocContent`, which speaks the Yjs sync protocol over a raw WebSocket rather than plain HTTP — exercising it live would need a full `wrangler dev` backend plus two real GitHub-authenticated accounts to generate and open an actual share link, disproportionate to a small, fully unit-tested, type-checked swap of an existing inline check for a call to `decideJoinTarget`. Verified instead by a clean type-check and the full test suite passing, matching the precedent already set by the untested `openShareModal`.
