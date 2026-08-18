# Single-Document Share Receive UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A receiver opening a share link that resolves to exactly one document always lands it as its own new workspace, named after the document, with no "join shared workspace" modal — for every receiver, regardless of how many workspaces they already have.

**Architecture:** A new pure, exported decision function `decideJoinTarget` in `client/src/collab.ts`, mirroring the existing sender-side `decideShareTarget` in the same file. `joinSharedLink` (the receive-side handler) calls it and branches on the result instead of its current inline zero-workspace-only check.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Single-doc detection is doc-count-based (`validDocs.length === 1`), not intent-based — this is deliberate, see the spec's Edge Case section.
- The new workspace's name for a single-doc share is the document's own name (`validDocs[0].name`), falling back to `"Untitled"` when empty — matching the exact fallback convention `decideShareTarget` already uses sender-side (`doc.name || "Untitled"`).
- A multi-doc workspace share's naming (`"Shared workspace"` placeholder) and the `JoinWorkspaceModal.svelte` component itself are unchanged — out of scope per the spec.
- `joinSharedLink` itself stays untested (async, WebSocket/DOM/module-state-coupled orchestration) — same boundary the codebase already draws around the sender-side equivalent, `openShareModal`, which calls the already-tested `decideShareTarget` but is itself untested. Only the new pure function gets unit tests.

---

### Task 1: `decideJoinTarget` — the receive-side decision function

**Files:**
- Modify: `client/src/collab.ts` (add the function; exact insertion point in Step 3)
- Test: `client/src/collab.test.ts` (add a new `describe` block after the existing `describe("decideShareTarget", ...)` block, which ends at line 58)

**Interfaces:**
- Produces:
  ```ts
  export type JoinDecision = { kind: "auto"; workspaceName: string } | { kind: "choice" };
  export function decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number): JoinDecision
  ```
  Task 2 imports nothing new for this (it's in the same file) — it calls `decideJoinTarget` directly.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `client/src/collab.test.ts`, after the closing `});` of the existing `describe("decideShareTarget", ...)` block (currently ends at line 58), and update the import on line 9 to also bring in `decideJoinTarget`:

```ts
import { decideShareTarget, decideJoinTarget } from "./collab";
```

```ts
describe("decideJoinTarget", () => {
  it("auto-lands a single document as its own new workspace, even with existing workspaces", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 3);
    expect(result).toEqual({ kind: "auto", workspaceName: "Release Notes" });
  });

  it("auto-lands a single document as its own new workspace when the receiver has none", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Release Notes" });
  });

  it("falls back to a placeholder name when the single document has no name", () => {
    const result = decideJoinTarget([{ name: "" }], 1);
    expect(result).toEqual({ kind: "auto", workspaceName: "Untitled" });
  });

  it("auto-lands a multi-document workspace when the receiver has zero workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Shared workspace" });
  });

  it("returns a choice decision for a multi-document workspace when the receiver has existing workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 2);
    expect(result).toEqual({ kind: "choice" });
  });

  it("treats zero valid documents as a multi-document share (no single doc to auto-land)", () => {
    const result = decideJoinTarget([], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Shared workspace" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- collab.test.ts`
Expected: FAIL — `decideJoinTarget` is not exported from `./collab` yet.

- [ ] **Step 3: Implement `decideJoinTarget`**

In `client/src/collab.ts`, add this immediately after the closing `}` of `decideShareTarget` (currently ends at line 751, just before `export async function openShareModal() {` on line 753):

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- collab.test.ts`
Expected: PASS — all tests in `collab.test.ts`, including the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add client/src/collab.ts client/src/collab.test.ts
git commit -m "feat: add decideJoinTarget for single-doc share receive decisions"
```

---

### Task 2: Wire `decideJoinTarget` into `joinSharedLink`

**Files:**
- Modify: `client/src/collab.ts:127-168` (the `joinSharedLink` function)

**Interfaces:**
- Consumes: `decideJoinTarget(validDocs, existingWorkspaceCount): JoinDecision` from Task 1, defined in the same file.

No new test file — `joinSharedLink` is untested per Global Constraints (same boundary as `openShareModal`). Verified by the full test suite (no regressions) and a type-check, matching how the sender-side equivalent code is verified today.

- [ ] **Step 1: Replace the zero-workspace-only check with the `decideJoinTarget` call**

In `client/src/collab.ts`, the current `joinSharedLink` (lines 127-168) ends with:

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

Replace it with:

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
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus Task 1's 6 new ones (364 total in the client+server suites combined as of this plan being written — exact count will be higher if other work has landed since; the point is zero failures and zero unexpected drops).

- [ ] **Step 4: Commit**

```bash
git add client/src/collab.ts
git commit -m "feat: land single-document shares as their own new workspace, no modal"
```
