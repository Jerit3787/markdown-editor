# Wikilink Rename Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renaming a document rewrites every `[[OldName]]` reference to it — in every document the renaming user can see, local or shared, active workspace or not — to `[[NewName]]`, instead of silently leaving them broken.

**Architecture:** A pure regex-based rewrite function, duplicated verbatim client-side and Worker-side (same pattern as `version-grouping.ts`). A pure client-side planner buckets every document containing `[[OldName]]` into three groups — the renamed document's own self-reference (needs the live editor), a local document (plain `docsStore` write), or a shared document (a new authenticated Worker endpoint that patches the room's Y.Text directly, safe regardless of whether that workspace is currently connected). An orchestrator applies all three buckets and returns a count; two call sites (the toolbar title field's blur-commit, and the rename-collision modal's Replace/Save-as-suffixed actions) trigger it and show a toast.

**Tech Stack:** TypeScript, Svelte 5, Yjs (Y.Text), Cloudflare Workers/Durable Objects, Vitest (`unit` + `components` projects), Playwright (`local` + `collab` projects).

**Spec:** `docs/superpowers/specs/2026-09-02-wikilink-rename-cascade-design.md` — read it alongside this plan; this plan implements it task-by-task but the spec has the full rationale for every decision (especially "Root cause" and the "no generic active-document bucket" explanation in the cascade module section).

## Global Constraints

- Exact-match only: a wikilink's captured name must equal `oldName` exactly (case-sensitive) to be rewritten — matches `resolveWikilinkTarget`'s existing exact-match rule.
- No wikilink aliasing exists yet (`[[Name|Display]]`) — nothing to preserve.
- A cascade edit is an ordinary content edit: bumps `updatedAt` for a local doc, and on the Worker side must NOT force an immediate version snapshot (use any Y.Doc transaction origin other than `"restore"` so the existing `maybeSnapshot` call in `handleDocUpdate` still fires normally).
- A shared document the current user isn't an `editor` on is silently skipped — never surfaced as an error, never blocks the rest of the cascade.
- Only the client that performed the rename runs the cascade — a remote `setDocName` update (a collaborator's own rename arriving via `collab.ts`) never re-triggers one.
- Every rename in this app operates on the currently active document (toolbar title field, `DocEditModal`, `DocList`'s "Rename" action which switches to the doc first) — there is no UI path to rename a non-active document. This is why the cascade has a `selfReferenceDoc` bucket instead of a generic "active document" bucket.
- Version bump: this is a user-facing minor version bump (`1.42.0`) with its own What's New entry, category `"Organization & Navigation"`.

---

### Task 1: Shared wikilink-rewrite primitive (client + Worker copies)

**Files:**
- Create: `client/src/wikilink-rewrite.ts`
- Create: `src/wikilink-rewrite.ts`
- Test: `tests/client/src/wikilink-rewrite.test.ts`
- Test: `tests/src/wikilink-rewrite.test.ts`

**Interfaces:**
- Produces: `rewriteWikilinkReferences(content: string, oldName: string, newName: string): string` (both files, identical). `findWikilinkOccurrences(content: string, name: string): { from: number; to: number }[]` (client file only).

- [x] **Step 1: Write the failing tests for the client copy**

Create `tests/client/src/wikilink-rewrite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rewriteWikilinkReferences, findWikilinkOccurrences } from "../../../client/src/wikilink-rewrite";

describe("rewriteWikilinkReferences", () => {
  it("rewrites a single exact match", () => {
    expect(rewriteWikilinkReferences("See [[Old]] for details", "Old", "New")).toBe("See [[New]] for details");
  });

  it("rewrites multiple occurrences", () => {
    expect(rewriteWikilinkReferences("[[Old]] and [[Old]] again", "Old", "New")).toBe("[[New]] and [[New]] again");
  });

  it("leaves a near-miss untouched", () => {
    expect(rewriteWikilinkReferences("[[OldSuffix]] stays", "Old", "New")).toBe("[[OldSuffix]] stays");
  });

  it("returns the input unchanged when the name never appears", () => {
    expect(rewriteWikilinkReferences("no links here", "Old", "New")).toBe("no links here");
  });

  it("leaves unrelated wikilinks to other names untouched", () => {
    expect(rewriteWikilinkReferences("[[Old]] and [[Other]]", "Old", "New")).toBe("[[New]] and [[Other]]");
  });
});

describe("findWikilinkOccurrences", () => {
  it("returns the character range of each exact match", () => {
    const content = "See [[Old]] here";
    const occurrences = findWikilinkOccurrences(content, "Old");
    expect(occurrences).toEqual([{ from: 4, to: 11 }]);
    expect(content.slice(occurrences[0]!.from, occurrences[0]!.to)).toBe("[[Old]]");
  });

  it("returns one range per occurrence, in order", () => {
    const occurrences = findWikilinkOccurrences("[[Old]] x [[Old]]", "Old");
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.from).toBe(0);
    expect(occurrences[1]!.from).toBe(10);
  });

  it("returns an empty array when the name doesn't appear", () => {
    expect(findWikilinkOccurrences("nothing here", "Old")).toEqual([]);
  });

  it("ignores a near-miss name", () => {
    expect(findWikilinkOccurrences("[[OldSuffix]]", "Old")).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/client/src/wikilink-rewrite.test.ts`
Expected: FAIL — `Cannot find module '../../../client/src/wikilink-rewrite'`

- [x] **Step 3: Write the client implementation**

Create `client/src/wikilink-rewrite.ts`:

```ts
// Kept separate from wikilinks.ts (which owns transformWikilinks/
// resolveWikilinkTarget/findBacklinks and imports Doc from ./types) so
// this file has zero dependency on client-only types — it's duplicated
// verbatim as src/wikilink-rewrite.ts for the Worker, same pattern
// version-grouping.ts already established for logic needed identically
// on both sides.
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

// Exact-match replace-all: only a fence whose captured name is
// *exactly* oldName is touched, same equality rule
// resolveWikilinkTarget already uses for resolution.
export function rewriteWikilinkReferences(content: string, oldName: string, newName: string): string {
  return content.replace(WIKILINK_RE, (match, name: string) => (name === oldName ? `[[${newName}]]` : match));
}

export interface WikilinkOccurrence {
  from: number;
  to: number;
}

// Every exact-match occurrence's character range in `content`, for a
// live CodeMirror edit (see app.ts's applyWikilinkRenameToActiveDoc).
export function findWikilinkOccurrences(content: string, name: string): WikilinkOccurrence[] {
  const re = /\[\[([^[\]\n]+)\]\]/g;
  const occurrences: WikilinkOccurrence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] === name) occurrences.push({ from: m.index, to: m.index + m[0].length });
  }
  return occurrences;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/client/src/wikilink-rewrite.test.ts`
Expected: PASS (9 tests)

- [x] **Step 5: Write the failing test for the Worker copy**

Create `tests/src/wikilink-rewrite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rewriteWikilinkReferences } from "../../src/wikilink-rewrite";

describe("rewriteWikilinkReferences (Worker copy)", () => {
  it("rewrites a single exact match", () => {
    expect(rewriteWikilinkReferences("See [[Old]] for details", "Old", "New")).toBe("See [[New]] for details");
  });

  it("rewrites multiple occurrences", () => {
    expect(rewriteWikilinkReferences("[[Old]] and [[Old]] again", "Old", "New")).toBe("[[New]] and [[New]] again");
  });

  it("leaves a near-miss untouched", () => {
    expect(rewriteWikilinkReferences("[[OldSuffix]] stays", "Old", "New")).toBe("[[OldSuffix]] stays");
  });

  it("returns the input unchanged when the name never appears", () => {
    expect(rewriteWikilinkReferences("no links here", "Old", "New")).toBe("no links here");
  });
});
```

- [x] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/src/wikilink-rewrite.test.ts`
Expected: FAIL — `Cannot find module '../../src/wikilink-rewrite'`

- [x] **Step 7: Write the Worker implementation**

Create `src/wikilink-rewrite.ts` — byte-for-byte the same `rewriteWikilinkReferences` function and its `WIKILINK_RE` constant as the client copy, minus `findWikilinkOccurrences` (the Worker never needs character ranges, only the final string):

```ts
// Duplicate of client/src/wikilink-rewrite.ts's rewriteWikilinkReferences
// (kept in sync by hand — same pattern as version-grouping.ts's two
// copies). This file has no findWikilinkOccurrences: the Worker only
// ever needs the final rewritten string, never character ranges.
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

// Exact-match replace-all: only a fence whose captured name is
// *exactly* oldName is touched, same equality rule
// resolveWikilinkTarget already uses for resolution.
export function rewriteWikilinkReferences(content: string, oldName: string, newName: string): string {
  return content.replace(WIKILINK_RE, (match, name: string) => (name === oldName ? `[[${newName}]]` : match));
}
```

- [x] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/src/wikilink-rewrite.test.ts`
Expected: PASS (4 tests)

- [x] **Step 9: Commit**

```bash
git add client/src/wikilink-rewrite.ts src/wikilink-rewrite.ts tests/client/src/wikilink-rewrite.test.ts tests/src/wikilink-rewrite.test.ts
git commit -m "feat: add shared wikilink-rewrite primitive (client + Worker copies)"
```

---

### Task 2: `findBacklinks` excludeId-optional + pure cascade planner

**Files:**
- Modify: `client/src/wikilinks.ts:25` (the `findBacklinks` function)
- Create: `client/src/wikilink-rename-cascade.ts`
- Test: `tests/client/src/wikilinks.test.ts` (extend)
- Test: `tests/client/src/wikilink-rename-cascade.test.ts`

**Interfaces:**
- Consumes: `findBacklinks` from `./wikilinks` (Task 2 modifies it); `Doc`, `Workspace` from `./types`.
- Produces: `WikilinkRenamePlan { selfReferenceDoc: Doc | null; localTargets: Doc[]; sharedTargets: { doc: Doc; workspace: Workspace }[] }` and `planWikilinkRenameCascade(oldName: string, docs: Doc[], renamedDocId: string, workspaces: Workspace[]): WikilinkRenamePlan` — both consumed by Task 5's orchestrator.

- [x] **Step 1: Write the failing test for the excludeId-optional change**

Add to `tests/client/src/wikilinks.test.ts`, inside the existing `describe("findBacklinks", ...)` block (after the last existing `it`):

```ts
  it("includes a self-referencing document when no excludeId is passed", () => {
    const selfRef: Doc[] = [{ id: "1", name: "Target", content: "[[Target]]", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }];
    expect(findBacklinks("Target", selfRef).map((d) => d.id)).toEqual(["1"]);
  });
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/client/src/wikilinks.test.ts`
Expected: FAIL — `Expected 2 arguments, but got 1` (TypeScript) or, if run without typechecking, the existing 3-argument signature still requires `excludeId` at the type level so this won't compile.

- [x] **Step 3: Make `excludeId` optional**

In `client/src/wikilinks.ts`, change:

```ts
export function findBacklinks(targetName: string, docs: Doc[], excludeId: string): Doc[] {
```

to:

```ts
export function findBacklinks(targetName: string, docs: Doc[], excludeId?: string): Doc[] {
```

(The function body — `docs.filter((d) => d.id !== excludeId && d.content.includes(needle))` — needs no change: `d.id !== undefined` is `true` for every real doc id, so omitting `excludeId` naturally excludes nothing.)

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/wikilinks.test.ts`
Expected: PASS (all existing `findBacklinks` tests plus the new one)

- [x] **Step 5: Write the failing tests for the planner**

Create `tests/client/src/wikilink-rename-cascade.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planWikilinkRenameCascade } from "../../../client/src/wikilink-rename-cascade";
import type { Doc, Workspace } from "../../../client/src/types";

function workspace(partial: Partial<Workspace> & { id: string }): Workspace {
  return { name: "ws", createdAt: 0, updatedAt: 0, ...partial };
}

function doc(partial: Partial<Doc> & { id: string; workspaceId: string }): Doc {
  return { name: "Doc", content: "", updatedAt: 0, createdAt: 0, ...partial };
}

describe("planWikilinkRenameCascade", () => {
  it("returns empty buckets when nothing references the name", () => {
    const docs = [doc({ id: "1", workspaceId: "ws1", content: "no links" })];
    const workspaces = [workspace({ id: "ws1" })];
    const plan = planWikilinkRenameCascade("Old", docs, "renamed-id", workspaces);
    expect(plan).toEqual({ selfReferenceDoc: null, localTargets: [], sharedTargets: [] });
  });

  it("buckets the renamed document's own self-reference separately, even in a shared workspace", () => {
    const renamed = doc({ id: "renamed-id", workspaceId: "ws1", content: "links to [[Old]] itself" });
    const workspaces = [workspace({ id: "ws1", shared: true, remoteId: "room-1" })];
    const plan = planWikilinkRenameCascade("Old", [renamed], "renamed-id", workspaces);
    expect(plan.selfReferenceDoc?.id).toBe("renamed-id");
    expect(plan.sharedTargets).toEqual([]);
    expect(plan.localTargets).toEqual([]);
  });

  it("buckets a document in a plain local workspace as a local target", () => {
    const other = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1" })];
    const plan = planWikilinkRenameCascade("Old", [other], "renamed-id", workspaces);
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
    expect(plan.sharedTargets).toEqual([]);
  });

  it("buckets a document in a shared workspace (with remoteId) as a shared target", () => {
    const other = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1", shared: true, remoteId: "room-1" })];
    const plan = planWikilinkRenameCascade("Old", [other], "renamed-id", workspaces);
    expect(plan.localTargets).toEqual([]);
    expect(plan.sharedTargets).toEqual([{ doc: other, workspace: workspaces[0] }]);
  });

  it("treats a workspace flagged shared but missing remoteId as a local target (defensive)", () => {
    const other = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1", shared: true })];
    const plan = planWikilinkRenameCascade("Old", [other], "renamed-id", workspaces);
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
    expect(plan.sharedTargets).toEqual([]);
  });

  it("buckets a doc whose workspace can't be found as a local target (defensive)", () => {
    const orphan = doc({ id: "2", workspaceId: "missing-ws", content: "[[Old]]" });
    const plan = planWikilinkRenameCascade("Old", [orphan], "renamed-id", []);
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
  });

  it("handles a mix of self-reference, local, and shared targets in one call", () => {
    const renamed = doc({ id: "renamed-id", workspaceId: "ws1", content: "[[Old]]" });
    const local = doc({ id: "2", workspaceId: "ws1", content: "[[Old]]" });
    const shared = doc({ id: "3", workspaceId: "ws2", content: "[[Old]]" });
    const workspaces = [workspace({ id: "ws1" }), workspace({ id: "ws2", shared: true, remoteId: "room-2" })];
    const plan = planWikilinkRenameCascade("Old", [renamed, local, shared], "renamed-id", workspaces);
    expect(plan.selfReferenceDoc?.id).toBe("renamed-id");
    expect(plan.localTargets.map((d) => d.id)).toEqual(["2"]);
    expect(plan.sharedTargets.map((t) => t.doc.id)).toEqual(["3"]);
  });
});
```

- [x] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/client/src/wikilink-rename-cascade.test.ts`
Expected: FAIL — `Cannot find module '../../../client/src/wikilink-rename-cascade'`

- [x] **Step 7: Write the planner implementation**

Create `client/src/wikilink-rename-cascade.ts`:

```ts
import type { Doc, Workspace } from "./types";
import { findBacklinks } from "./wikilinks";

export interface WikilinkRenamePlan {
  // Set only when the renamed document's own content contains a
  // self-referential [[OldName]] — needs the live editor, not a
  // docsStore write, since the renamed doc is always the open one.
  // See the design spec's "why there's no generic active-document
  // bucket" note: every rename in this app operates on the currently
  // active document, so the renamed doc IS the active one.
  selfReferenceDoc: Doc | null;
  localTargets: Doc[]; // plain writes via docsStore
  sharedTargets: { doc: Doc; workspace: Workspace }[]; // need the HTTP endpoint
}

// Pure — no store reads, no network, no DOM. No excludeId passed to
// findBacklinks (unlike DocInfoPanel's backlinks-panel use of it) —
// the renamed doc's own content is a legitimate candidate here, just
// routed to selfReferenceDoc instead of one of the other buckets.
export function planWikilinkRenameCascade(oldName: string, docs: Doc[], renamedDocId: string, workspaces: Workspace[]): WikilinkRenamePlan {
  const candidates = findBacklinks(oldName, docs);
  const plan: WikilinkRenamePlan = { selfReferenceDoc: null, localTargets: [], sharedTargets: [] };
  for (const doc of candidates) {
    if (doc.id === renamedDocId) {
      plan.selfReferenceDoc = doc;
      continue;
    }
    const workspace = workspaces.find((w) => w.id === doc.workspaceId);
    if (workspace?.shared && workspace.remoteId) plan.sharedTargets.push({ doc, workspace });
    else plan.localTargets.push(doc);
  }
  return plan;
}
```

- [x] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/client/src/wikilink-rename-cascade.test.ts`
Expected: PASS (7 tests)

- [x] **Step 9: Commit**

```bash
git add client/src/wikilinks.ts client/src/wikilink-rename-cascade.ts tests/client/src/wikilinks.test.ts tests/client/src/wikilink-rename-cascade.test.ts
git commit -m "feat: make findBacklinks' excludeId optional, add pure wikilink-rename-cascade planner"
```

---

### Task 3: `rewriteWikilinksInLocalDoc` in `stores/docs.ts`

**Files:**
- Modify: `client/src/stores/docs.ts` (add new exported function, near `renameDoc` at line 394)
- Test: `tests/client/src/stores/docs.test.ts` (extend)

**Interfaces:**
- Consumes: `rewriteWikilinkReferences` from `../wikilink-rewrite` (Task 1); `findDocById`, `updateDoc` (private to the module, already exist), `persistDocs` (already exists).
- Produces: `rewriteWikilinksInLocalDoc(id: string, oldName: string, newName: string): boolean` — consumed by Task 5's orchestrator.

- [x] **Step 1: Write the failing test**

Add to `tests/client/src/stores/docs.test.ts`, as a new `describe` block (this file uses the dynamic-import-per-test pattern shown by its existing `createDoc` tests — follow it exactly since `vi.resetModules()` in `beforeEach` means a static top-of-file import would see stale module state):

```ts
describe("rewriteWikilinksInLocalDoc", () => {
  it("rewrites a matching wikilink and bumps updatedAt", async () => {
    const { createDoc, rewriteWikilinksInLocalDoc, findDocById } = await import("../../../../client/src/stores/docs");
    const doc = createDoc({ name: "Linker", content: "See [[Old]] here" });
    const before = doc.updatedAt;
    const changed = rewriteWikilinksInLocalDoc(doc.id, "Old", "New");
    expect(changed).toBe(true);
    const updated = findDocById(doc.id);
    expect(updated?.content).toBe("See [[New]] here");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("returns false and makes no change when the name doesn't appear", async () => {
    const { createDoc, rewriteWikilinksInLocalDoc, findDocById } = await import("../../../../client/src/stores/docs");
    const doc = createDoc({ name: "NoLinks", content: "nothing here" });
    const before = findDocById(doc.id)!.updatedAt;
    const changed = rewriteWikilinksInLocalDoc(doc.id, "Old", "New");
    expect(changed).toBe(false);
    expect(findDocById(doc.id)!.content).toBe("nothing here");
    expect(findDocById(doc.id)!.updatedAt).toBe(before);
  });

  it("returns false for an id that doesn't exist", async () => {
    const { rewriteWikilinksInLocalDoc } = await import("../../../../client/src/stores/docs");
    expect(rewriteWikilinksInLocalDoc("nonexistent", "Old", "New")).toBe(false);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: FAIL — `rewriteWikilinksInLocalDoc is not a function` (or not exported)

- [x] **Step 3: Write the implementation**

In `client/src/stores/docs.ts`, add the import at the top of the file alongside the other relative imports:

```ts
import { rewriteWikilinkReferences } from "../wikilink-rewrite";
```

Then add the new function immediately after `renameDoc` (currently at line 394-396):

```ts
// Rewrites [[oldName]] -> [[newName]] in one local (non-shared, non-
// active) document's content, as part of a rename cascade (see
// wikilink-rename-cascade.ts). Returns whether anything actually
// changed, so the cascade orchestrator can count it. A real content
// edit — bumps updatedAt like any other, so the sidebar reorders and
// autosave/version-history capture it normally.
export function rewriteWikilinksInLocalDoc(id: string, oldName: string, newName: string): boolean {
  const doc = findDocById(id);
  if (!doc) return false;
  const rewritten = rewriteWikilinkReferences(doc.content, oldName, newName);
  if (rewritten === doc.content) return false;
  updateDoc(id, { content: rewritten, updatedAt: Date.now() });
  persistDocs();
  return true;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: PASS (all existing tests plus the 3 new ones)

- [x] **Step 5: Commit**

```bash
git add client/src/stores/docs.ts tests/client/src/stores/docs.test.ts
git commit -m "feat: add rewriteWikilinksInLocalDoc to docs store"
```

---

### Task 4: Worker endpoint for shared-document cascade edits

**Files:**
- Modify: `src/workspace-room.ts` (new handler + route dispatch inside `fetch()`)
- Modify: `src/worker.ts` (new top-level route)
- Test: `tests/src/workspace-room.test.ts` (extend)

**Interfaces:**
- Consumes: `rewriteWikilinkReferences` from `./wikilink-rewrite` (Task 1); `this.authorize`, `this.loadDocRoom` (already exist on `WorkspaceRoom`).
- Produces: `WorkspaceRoom.handleWikilinkRenameRequest(request: Request, docId: string): Promise<Response>`, reachable at `POST /api/workspace/:workspaceId/docs/:docId/wikilink-rename` — consumed by Task 5's `pushWikilinkRenameToSharedDoc`.

- [x] **Step 1: Write the failing tests**

Add to `tests/src/workspace-room.test.ts`, as a new `describe` block (uses the same `fakeState()`, `fakeEnvWithSecret`, `encryptSession` helpers the file's existing `describe("WorkspaceRoom.handleVersionRestoreContentRequest", ...)` block uses — check that block for the exact helper import/usage pattern already in this file before writing these):

```ts
describe("WorkspaceRoom.handleWikilinkRenameRequest", () => {
  it("rejects a request with no session on a restricted workspace", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.loadDocRoom("docA");
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(401);
  });

  it("rejects a non-editor", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "reviewer" }],
    });
    await room.loadDocRoom("docA");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "bob" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(403);
  });

  it("rejects a request missing oldName or newName", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.loadDocRoom("docA");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(400);
  });

  it("rewrites the room's live content and returns changed: true", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "See [[Old]] here"), "storage");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(true);
    expect(docRoom.doc.getText("content").toString()).toBe("See [[New]] here");
  });

  it("returns changed: false and doesn't transact when the name isn't present", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "unrelated content"), "storage");
    let updateFired = false;
    docRoom.doc.on("update", () => {
      updateFired = true;
    });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
    expect(docRoom.doc.getText("content").toString()).toBe("unrelated content");
    expect(updateFired).toBe(false);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: FAIL — `room.handleWikilinkRenameRequest is not a function`

- [x] **Step 3: Write the handler implementation**

In `src/workspace-room.ts`, add the import at the top of the file alongside the other relative imports (after the `access-visibility` import, matching the file's existing import ordering):

```ts
import { rewriteWikilinkReferences } from "./wikilink-rewrite";
```

Then add the new method — place it directly after `handleVersionRestoreContentRequest` (the method whose pattern it mirrors):

```ts
  // Rewrites [[oldName]] -> [[newName]] wherever it appears in this
  // document's live content, computed against the DO's own authoritative
  // text — never trusts a client-supplied "new content" wholesale, since
  // the requesting client's own cached copy of a document it isn't
  // actively viewing can be stale. Best-effort from the caller's
  // perspective: a 403 here just means the cascade skips this one
  // document rather than failing the whole rename. Uses a distinct
  // transact origin (not "restore") so the ordinary maybeSnapshot capture
  // in handleDocUpdate still applies — this is a normal edit, not a
  // version restore, so it shouldn't force an immediate snapshot.
  async handleWikilinkRenameRequest(request: Request, docId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can update links in this document.", { status: 403 });

    let body: { oldName?: unknown; newName?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const oldName = typeof body.oldName === "string" ? body.oldName : undefined;
    const newName = typeof body.newName === "string" ? body.newName : undefined;
    if (!oldName || !newName) return new Response("oldName and newName are required.", { status: 400 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    const current = text.toString();
    const rewritten = rewriteWikilinkReferences(current, oldName, newName);
    if (rewritten === current) return Response.json({ changed: false });

    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, rewritten);
    }, "wikilink-rename");
    return Response.json({ changed: true });
  }
```

Then wire it into `fetch()`'s routing — add this alongside the existing `/docs/:id/versions/*` matches (right after the `versionsListMatch` block, before the WebSocket-upgrade fallthrough):

```ts
    const wikilinkRenameMatch = url.pathname.match(/\/docs\/([^/]+)\/wikilink-rename$/);
    if (wikilinkRenameMatch) return this.handleWikilinkRenameRequest(request, wikilinkRenameMatch[1]!);
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (all existing tests plus the 5 new ones)

- [x] **Step 5: Add the top-level Worker route**

In `src/worker.ts`, add the new regex constant alongside the other `WORKSPACE_DOC_*_PATH` constants near the top of the file:

```ts
const WORKSPACE_DOC_WIKILINK_RENAME_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/wikilink-rename$/;
```

Then add the dispatch inside `fetch()`, alongside the other `workspaceDoc*Match` blocks (e.g. right after the `workspaceDocCommentsMatch` block):

```ts
    const workspaceWikilinkRenameMatch = url.pathname.match(WORKSPACE_DOC_WIKILINK_RENAME_PATH);
    if (workspaceWikilinkRenameMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceWikilinkRenameMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }
```

- [x] **Step 6: Run the full server test suite to check nothing broke**

Run: `npx vitest run tests/src/`
Expected: PASS (all files)

- [x] **Step 7: Commit**

```bash
git add src/workspace-room.ts src/worker.ts tests/src/workspace-room.test.ts
git commit -m "feat: add Worker endpoint for wikilink-rename cascade into shared documents"
```

---

### Task 5: Client HTTP wrapper + cascade orchestrator

**Files:**
- Modify: `client/src/history.ts` (new function, alongside `restoreSharedVersionContent`)
- Modify: `client/src/wikilink-rename-cascade.ts` (add the orchestrator to the file created in Task 2)
- Test: `tests/client/src/wikilink-rename-cascade.test.ts` (extend)

**Interfaces:**
- Consumes: `planWikilinkRenameCascade` (Task 2, same file); `rewriteWikilinksInLocalDoc` from `./stores/docs` (Task 3); `docsStore`, `workspacesStore` from `./stores/docs`/`./stores/workspaces`; `window.MDE.applyWikilinkRenameToActiveDoc` (Task 6 adds this to the real bridge — mocked in this task's tests).
- Produces: `pushWikilinkRenameToSharedDoc(workspaceRemoteId: string, docId: string, oldName: string, newName: string): Promise<boolean>` (in `history.ts`) and `runWikilinkRenameCascade(renamedDocId: string, oldName: string, newName: string): Promise<number>` (in `wikilink-rename-cascade.ts`) — both consumed by Task 6's `app.ts` wiring.

- [x] **Step 1: Write the failing test for the HTTP wrapper's shape**

This function is covered indirectly through the orchestrator's mocked-`fetch` tests below (matching how `restoreSharedVersionContent` has no dedicated unit test of its own in this codebase — check `tests/client/src/history.test.ts` to confirm it isn't tested directly before writing this). No standalone test file needed for this step; proceed to Step 2.

- [x] **Step 2: Write the HTTP wrapper implementation**

In `client/src/history.ts`, add this function directly after `restoreSharedVersionContent`:

```ts
export async function pushWikilinkRenameToSharedDoc(workspaceRemoteId: string, docId: string, oldName: string, newName: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceRemoteId)}/docs/${encodeURIComponent(docId)}/wikilink-rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldName, newName }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { changed: boolean };
    return data.changed;
  } catch (err) {
    return false;
  }
}
```

- [x] **Step 3: Run the client test suite to confirm nothing broke**

Run: `npx vitest run tests/client/src/history.test.ts`
Expected: PASS (unchanged — this step only adds an export, no behavior change to existing functions)

- [x] **Step 4: Write the failing tests for the orchestrator**

Add to `tests/client/src/wikilink-rename-cascade.test.ts` (the file Task 2 created), as a new `describe` block. This needs `docsStore`/`workspacesStore` seeded and `window.MDE`/`fetch` mocked — use the same dynamic-import-after-`vi.resetModules()` pattern `docs.test.ts` uses, since `docsStore`/`workspacesStore` are module-level singletons.

`runWikilinkRenameCascade`'s own implementation (Step 6, below) calls `window.MDE.applyWikilinkRenameToActiveDoc(...)` directly, and Vitest's `unit` project has no `environment` configured, which defaults to plain Node — there is no global `window` there at all. This needs a `// @vitest-environment jsdom` pragma. Vitest scans for it anywhere in the file and applies it to the *entire* file regardless of physical position — this repo already has the exact same situation (a file mixing pure-function tests with DOM-needing ones) in `tests/client/src/math-preview.test.ts` and `tests/client/src/mermaid-preview.test.ts`, both of which place the pragma directly above the block that needs it rather than at the top of the file; follow that same convention here rather than moving Task 2's existing top-of-file import. This is harmless for Task 2's existing pure-planner tests either way — jsdom is a superset environment they behave identically under.

First, extend this file's existing top-of-file import line (added in Task 2) to add the three new imports this block needs:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
```

Then add, at the end of the file, the pragma immediately followed by the new `describe` block:

```ts
// @vitest-environment jsdom
describe("runWikilinkRenameCascade", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).MDE;
  });

  it("counts a local target rewrite and shows no active-doc or shared work when there's none", async () => {
    const { createDoc } = await import("../../../client/src/stores/docs");
    const { runWikilinkRenameCascade } = await import("../../../client/src/wikilink-rename-cascade");
    const renamed = createDoc({ name: "New", content: "" });
    const linker = createDoc({ name: "Linker", content: "[[Old]]" });
    (window as any).MDE = { applyWikilinkRenameToActiveDoc: vi.fn().mockReturnValue(false) };

    const count = await runWikilinkRenameCascade(renamed.id, "Old", "New");

    expect(count).toBe(1);
    const { findDocById } = await import("../../../client/src/stores/docs");
    expect(findDocById(linker.id)?.content).toBe("[[New]]");
  });

  it("counts a self-reference fixed via the active-editor bridge", async () => {
    const { createDoc } = await import("../../../client/src/stores/docs");
    const { runWikilinkRenameCascade } = await import("../../../client/src/wikilink-rename-cascade");
    const renamed = createDoc({ name: "New", content: "links to [[Old]] itself" });
    const applyToActive = vi.fn().mockReturnValue(true);
    (window as any).MDE = { applyWikilinkRenameToActiveDoc: applyToActive };

    const count = await runWikilinkRenameCascade(renamed.id, "Old", "New");

    expect(count).toBe(1);
    expect(applyToActive).toHaveBeenCalledWith("Old", "New");
  });

  it("counts a shared target pushed successfully, and doesn't let one failure suppress others", async () => {
    const { createDoc, activeDocContent } = await import("../../../client/src/stores/docs");
    const { createWorkspace, workspacesStore } = await import("../../../client/src/stores/workspaces");
    const { runWikilinkRenameCascade } = await import("../../../client/src/wikilink-rename-cascade");
    const renamed = createDoc({ name: "New", content: "" });
    const sharedWs = createWorkspace("Shared");
    workspacesStore.update((all) => all.map((w) => (w.id === sharedWs.id ? { ...w, shared: true, remoteId: "room-1" } : w)));
    const failingWs = createWorkspace("AlsoShared");
    workspacesStore.update((all) => all.map((w) => (w.id === failingWs.id ? { ...w, shared: true, remoteId: "room-2" } : w)));
    createDoc({ workspaceId: sharedWs.id, name: "Good", content: "[[Old]]" });
    // createDoc makes its new doc the active one, and the *next* createDoc
    // call flushes activeDocContent (the live-editor buffer store) into
    // whichever doc was active before it — in this bare unit-test
    // environment activeDocContent never tracks a real editor, so without
    // this it would silently clobber "Good"'s content back to "" the
    // moment "Bad" is created. Setting it to match first makes that flush
    // a no-op.
    activeDocContent.set("[[Old]]");
    createDoc({ workspaceId: failingWs.id, name: "Bad", content: "[[Old]]" });
    (window as any).MDE = { applyWikilinkRenameToActiveDoc: vi.fn().mockReturnValue(false) };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("room-1")) return new Response(JSON.stringify({ changed: true }), { status: 200 });
      return new Response("nope", { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const count = await runWikilinkRenameCascade(renamed.id, "Old", "New");

    // Only the room-1 push (the "Good" target) counts — the room-2 push
    // (the "Bad" target) returns 403, which pushWikilinkRenameToSharedDoc
    // reports as `false` rather than throwing, so it just doesn't add to
    // the total. Both fetches still happen (asserted below) — one
    // target's failure doesn't stop the loop from reaching the other.
    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [x] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/client/src/wikilink-rename-cascade.test.ts`
Expected: FAIL — `runWikilinkRenameCascade is not a function`

- [x] **Step 6: Write the orchestrator implementation**

Append to `client/src/wikilink-rename-cascade.ts` (the file from Task 2), adding the needed imports at the top of the file (extend the existing import list):

```ts
import { get } from "svelte/store";
import { docsStore, rewriteWikilinksInLocalDoc } from "./stores/docs";
import { workspacesStore } from "./stores/workspaces";
import { pushWikilinkRenameToSharedDoc } from "./history";
```

Then add the orchestrator function at the end of the file:

```ts
// Reads the live stores, plans, applies every bucket, and returns how
// many documents actually changed (0 -> caller shows no toast). A
// failure applying to one shared target never stops the others -- each
// is independent and best-effort. Nothing here awaits before the
// selfReferenceDoc/localTargets handling, so it all runs synchronously
// in the same task as the rename commit -- no risk of the active
// document having changed underneath it by the time
// applyWikilinkRenameToActiveDoc runs.
export async function runWikilinkRenameCascade(renamedDocId: string, oldName: string, newName: string): Promise<number> {
  const docs = get(docsStore);
  const workspaces = get(workspacesStore);
  const plan = planWikilinkRenameCascade(oldName, docs, renamedDocId, workspaces);

  let changed = 0;
  if (plan.selfReferenceDoc && window.MDE.applyWikilinkRenameToActiveDoc(oldName, newName)) changed++;
  for (const doc of plan.localTargets) {
    if (rewriteWikilinksInLocalDoc(doc.id, oldName, newName)) changed++;
  }
  for (const { doc, workspace } of plan.sharedTargets) {
    if (await pushWikilinkRenameToSharedDoc(workspace.remoteId!, doc.id, oldName, newName)) changed++;
  }
  return changed;
}
```

- [x] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/client/src/wikilink-rename-cascade.test.ts`
Expected: PASS (all planner tests from Task 2 plus the 3 new orchestrator tests)

- [x] **Step 8: Commit**

```bash
git add client/src/history.ts client/src/wikilink-rename-cascade.ts tests/client/src/wikilink-rename-cascade.test.ts
git commit -m "feat: add pushWikilinkRenameToSharedDoc and runWikilinkRenameCascade orchestrator"
```

---

### Task 6: Wire the cascade into the UI (app.ts, RenameCollisionModal, MDEBridge type)

**Files:**
- Modify: `client/src/types.ts` (extend `MDEBridge` interface)
- Modify: `client/src/app.ts` (new bridge method, new local function, wire into `commitActiveDocRename`)
- Modify: `client/src/components/RenameCollisionModal.svelte` (wire into `replace()`/`saveAsSuffixed()`)
- Test: `tests/e2e/local/wikilink-rename-cascade.spec.ts` (new)

**Interfaces:**
- Consumes: `findWikilinkOccurrences` from `./wikilink-rewrite` (Task 1); `runWikilinkRenameCascade` from `./wikilink-rename-cascade` (Task 5); `showToast` from `./stores/toast` (already imported in `app.ts`).
- Produces: `window.MDE.applyWikilinkRenameToActiveDoc(oldName: string, newName: string): boolean`; `window.MDE.cascadeWikilinkRenameAndToast(docId: string, oldName: string, newName: string): Promise<void>`.

- [x] **Step 1: Extend the `MDEBridge` type**

In `client/src/types.ts`, add these two members to the `MDEBridge` interface, right after `commitActiveDocRename(previousName: string): void;` (around line 199):

```ts
  // Rewrites every exact [[oldName]] occurrence in the ACTIVE document's
  // live editor buffer to [[newName]], as one CodeMirror transaction (one
  // undo step). Returns whether anything was rewritten. Part of the
  // wikilink rename cascade (wikilink-rename-cascade.ts) -- called only
  // when the renamed document's own content self-references its old name.
  applyWikilinkRenameToActiveDoc(oldName: string, newName: string): boolean;
  // Runs the wikilink rename cascade for a just-committed rename and
  // shows a toast if anything changed. Exposed on the bridge so
  // RenameCollisionModal.svelte (which finalizes a rename outside
  // commitActiveDocRename's own call site) can trigger the same cascade.
  cascadeWikilinkRenameAndToast(docId: string, oldName: string, newName: string): Promise<void>;
```

- [x] **Step 2: Add the imports to `app.ts`**

In `client/src/app.ts`, add these two imports alongside the existing `./stores/docs` and other local imports (near the top of the file, after the `import { showToast } from "./stores/toast";` line):

```ts
import { findWikilinkOccurrences } from "./wikilink-rewrite";
import { runWikilinkRenameCascade } from "./wikilink-rename-cascade";
```

- [x] **Step 3: Add the bridge method implementation and the toast wrapper**

In `client/src/app.ts`, add a new local function right after `commitActiveDocRename` (currently ending around line 623):

```ts
  async function cascadeWikilinkRenameAndToast(docId: string, oldName: string, newName: string) {
    const count = await runWikilinkRenameCascade(docId, oldName, newName);
    if (count > 0) showToast(`Updated ${count} link${count === 1 ? "" : "s"} to "${newName}"`, "success");
  }
```

- [x] **Step 4: Wire the no-collision commit path**

In `client/src/app.ts`, modify `commitActiveDocRename` (currently at line 610) to call the new function. Change:

```ts
    const colliding = findCollidingDoc(doc.id, finalName);
    if (colliding) {
      renameCollision.set({ docId: doc.id, pendingName: finalName, previousName, collidingDocId: colliding.id });
    }
  }
```

to:

```ts
    const colliding = findCollidingDoc(doc.id, finalName);
    if (colliding) {
      renameCollision.set({ docId: doc.id, pendingName: finalName, previousName, collidingDocId: colliding.id });
      return;
    }
    void cascadeWikilinkRenameAndToast(doc.id, previousName, finalName);
  }
```

- [x] **Step 5: Add both new methods to the `window.MDE` object literal**

In `client/src/app.ts`, add both to the bridge object (near `renameActiveDoc,`/`commitActiveDocRename,` at lines 1186-1187):

```ts
    renameActiveDoc,
    commitActiveDocRename,
    applyWikilinkRenameToActiveDoc(oldName, newName) {
      const content = cm.state.doc.toString();
      const occurrences = findWikilinkOccurrences(content, oldName);
      if (occurrences.length === 0) return false;
      cm.dispatch({ changes: occurrences.map((o) => ({ from: o.from, to: o.to, insert: `[[${newName}]]` })) });
      return true;
    },
    cascadeWikilinkRenameAndToast,
```

- [x] **Step 6: Wire `RenameCollisionModal.svelte`'s finalizing actions**

In `client/src/components/RenameCollisionModal.svelte`, modify `replace()` and `saveAsSuffixed()`. Change:

```ts
  function replace() {
    const state = $renameCollision;
    if (!state) return;
    removeDocById(state.collidingDocId);
    commitName(state.pendingName);
  }

  function saveAsSuffixed() {
    if (!$renameCollision) return;
    commitName(suggestedName);
  }
```

to:

```ts
  function replace() {
    const state = $renameCollision;
    if (!state) return;
    removeDocById(state.collidingDocId);
    commitName(state.pendingName);
    void window.MDE.cascadeWikilinkRenameAndToast(state.docId, state.previousName, state.pendingName);
  }

  function saveAsSuffixed() {
    const state = $renameCollision;
    if (!state) return;
    const finalName = suggestedName;
    commitName(finalName);
    void window.MDE.cascadeWikilinkRenameAndToast(state.docId, state.previousName, finalName);
  }
```

(`suggestedName` must be captured into `finalName` *before* `commitName` runs — `commitName` calls `renameCollision.set(null)`, and `suggestedName` is a `$derived` value that recomputes to `""` once `$renameCollision` is null, so reading it after `commitName` would pass an empty string to the cascade.)

`cancel()` is untouched — it reverts to `previousName`, so no rename actually happened and no cascade is needed.

- [x] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS — confirms the `MDEBridge` interface, its implementation in `app.ts`, and both call sites in `RenameCollisionModal.svelte` all agree on types.

- [x] **Step 8: Manually verify in the running app**

Run: `npm run build && npm run dev`, then in the browser:
1. Create two local documents, "Alpha" and "Beta". In "Beta", type `See [[Alpha]] for more`.
2. Switch to "Alpha", rename it to "Gamma" via the toolbar title field (type the new name, then click elsewhere or press Enter to blur).
3. Confirm a toast appears ("Updated 1 link to \"Gamma\"").
4. Switch to "Beta" and confirm its content now reads `See [[Gamma]] for more`.
5. Repeat, this time triggering `RenameCollisionModal`: create a document named "Gamma" already, then try renaming "Beta" to "Gamma" — confirm the collision modal appears, click "Replace", and confirm the cascade still ran (check any other document that referenced "Beta").

- [x] **Step 9: Write the local Playwright e2e spec**

Check `tests/e2e/local/slash-and-wikilinks.spec.ts` first for this project's existing helpers for creating documents and interacting with the toolbar title field (e.g. a shared `test.beforeEach` fixture, selectors for `#docTitle`, how a new document is created) — reuse them rather than inventing new selectors. Then create `tests/e2e/local/wikilink-rename-cascade.spec.ts` following that file's structure, covering:

1. Two documents, one linking to the other via `[[Name]]`; rename the target through the toolbar title field; assert the referencing document's content updated (switch to it and check the editor content) and that a toast appeared.
2. A collision case: create a document already named "Target", attempt to rename another document to "Target" (triggering `RenameCollisionModal`), click "Replace", and assert the cascade still updated a third document that referenced the renamed one's old name.
3. A self-reference case: a document containing `[[OwnOldName]]` referring to its own current name; rename it; assert the open editor's own buffer updated in place (no need to switch away and back).

- [x] **Step 10: Run the new e2e spec**

Run: `npx playwright test --project=local wikilink-rename-cascade`
Expected: PASS (3 tests)

- [x] **Step 11: Run the full local test suite to check nothing broke**

Run: `npm test && npm run typecheck && npx playwright test --project=local`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add client/src/types.ts client/src/app.ts client/src/components/RenameCollisionModal.svelte tests/e2e/local/wikilink-rename-cascade.spec.ts
git commit -m "feat: wire wikilink rename cascade into the rename UI"
```

---

### Task 7: Collab e2e coverage

**Files:**
- Create: a new spec under `tests/e2e/collab/` (name it `wikilink-rename-cascade.spec.ts` to match the local spec's name)

**Interfaces:**
- Consumes: nothing new — exercises the full stack (Task 4's Worker endpoint, Task 5's orchestrator, Task 6's UI wiring) against a real running Worker.

- [ ] **Step 1: Study the existing collab e2e setup**

Read `tests/scripts/e2e-collab.sh` and one existing spec in `tests/e2e/collab/` (e.g. the suggestion-mode one referenced in workspace-room test output, `tests/e2e/collab/suggestion-mode.spec.ts`) to find: how two browser contexts are set up as two different roles in the same shared workspace, how dev-login is used to sign each in, and how a document is opened/switched between contexts. Reuse those exact helpers.

- [ ] **Step 2: Write the collab e2e spec**

Create `tests/e2e/collab/wikilink-rename-cascade.spec.ts` with one test: two connected browser contexts (both editors) joined to the same shared workspace, which has two documents — "Target" (open in context A) and "Linker" (containing `[[Target]]`, NOT open in context B — i.e. a background document from context B's perspective). Context A renames "Target" to "Renamed" via the toolbar title field. Assert that once context B switches to (opens) "Linker", its content shows `[[Renamed]]` — confirming the change reached it through the real Worker endpoint and Yjs sync, not merely context A's own local cache.

- [ ] **Step 3: Run the collab e2e suite**

Run: `npm run test:e2e:collab`
Expected: PASS (this new test plus every existing collab spec)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/collab/wikilink-rename-cascade.spec.ts
git commit -m "test: add collab e2e coverage for wikilink rename cascade"
```

---

### Task 8: Version / CHANGELOG / What's New / ROADMAP

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `ROADMAP.md`

**Interfaces:** None — documentation/metadata only.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.41.2"` to `"version": "1.42.0"`.

In `package-lock.json`, hand-edit both `"version": "1.41.2"` occurrences at the top of the file (the root package entry and the `""` entry under `packages`) to `"1.42.0"` — do not run a full `npm install --package-lock-only` regeneration (per this repo's CLAUDE.md, that can pull in unrelated lockfile churn).

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, add a new section at the top (Keep a Changelog format), right after the header block and before the current top entry:

```markdown
## [1.42.0] - 2026-09-02

### Added

- **Wikilink rename cascade.** Renaming a document now automatically rewrites every `[[OldName]]` reference to it elsewhere — in local documents, in the document itself if it self-references its own old name, and in any shared workspace's documents (even one you aren't currently connected to) via a new authenticated endpoint that patches that workspace's live content directly. A brief toast reports how many links were updated; nothing appears when there was nothing to fix. A document in a shared workspace you don't have editor access to is silently left as-is, same as before this feature.
```

(Use today's actual date if this plan is executed on a different day than 2026-09-02.)

- [ ] **Step 3: Add the What's New entry**

In `client/src/whats-new-entries.ts`, append a new entry to the end of the `WHATS_NEW_ENTRIES` array (after the `1.41.0` entry):

```ts
  {
    version: "1.42.0",
    title: "Wikilink Rename Cascade",
    description:
      "Renaming a document now automatically fixes every [[Name]] reference to it elsewhere, instead of leaving them pointing at a name that no longer exists — including references in shared workspace documents you aren't currently connected to.",
    screenshot: "/whats-new/wikilink-rename-cascade.png",
    category: "Organization & Navigation",
  },
```

Note: the `screenshot` path points at an asset that doesn't exist yet (`client/public/whats-new/wikilink-rename-cascade.png`) — per this repo's existing convention (see `whats-new-entries.ts`'s own header comment), a real screenshot is expected but its absence doesn't block `WhatsNew.svelte`'s dev-mode version-match check, which only warns about a missing *entry*, not a missing image. Flag this to the user/reviewer rather than fabricating a placeholder image.

- [ ] **Step 4: Update ROADMAP.md**

In `ROADMAP.md`, find the line `- [ ] Wikilink rename cascade — v1.15.0 renaming a document never` (in the deferred-scope list near the other wikilink items) and change it to a checked, shipped entry matching the style of neighboring shipped items, e.g.:

```markdown
- [x] **Wikilink rename cascade.** Renaming a document now rewrites
      every `[[OldName]]` reference to it elsewhere — local documents,
      a self-reference in the renamed document itself, and any shared
      workspace's documents (even one not currently connected) via a
      new authenticated endpoint (v1.42.0).
```

(Check the exact current wording of this line in `ROADMAP.md` first with `grep -n "rename cascade" ROADMAP.md` — the text above is illustrative of the shipped-item style to match, not necessarily the exact original unchecked wording.)

- [ ] **Step 5: Verify the version-match warning is gone**

Run: `npm test` and check the console output doesn't include `WhatsNew: no announcement entry for the current version` (this warning appears in test output when `__APP_VERSION__` and the last `WHATS_NEW_ENTRIES` entry's version disagree).
Expected: no such warning; all tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts ROADMAP.md
git commit -m "chore: bump version to 1.42.0 for wikilink rename cascade"
```

---

### Task 9: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full unit/component test suite**

Run: `npm test`
Expected: PASS, all files (including every new test file from Tasks 1-5)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (root strict tsconfig + client's own via svelte-check)

- [ ] **Step 3: Formatting**

Run: `npm run format:check`
Expected: PASS. If it fails, run `npm run format` and review the diff before re-committing.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds, no errors.

- [ ] **Step 5: Local e2e suite**

Run: `npm run test:e2e:local`
Expected: PASS, all specs including the new `wikilink-rename-cascade.spec.ts`.

- [ ] **Step 6: Collab e2e suite**

Run: `npm run test:e2e:collab`
Expected: PASS, all specs including the new collab spec from Task 7.

- [ ] **Step 7: Commit any formatting fixes**

If Step 3 required running `npm run format`, commit the result:

```bash
git add -A
git commit -m "chore: apply formatting"
```

- [ ] **Step 8: Hand off**

Report the final state to the user/reviewer: all six verification commands green, the two new user-visible behaviors (cascade + toast), the one deliberately-missing asset (`whats-new/wikilink-rename-cascade.png`) flagged for follow-up, and the branch ready for the push/PR/merge workflow described in this repo's own CLAUDE.md ("Shipping a change" section) — do not push, open a PR, or merge without the user's separate go-ahead for that step.
