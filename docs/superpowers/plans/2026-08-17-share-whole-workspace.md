# Share Whole Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing Share button share an entire multi-document workspace as-is, instead of always isolating the active document into a new one — and fix the related bug where an already-shared workspace incorrectly re-triggers the isolate prompt.

**Architecture:** A new pure decision function in `collab.ts` replaces the current `siblingCount > 1` check with a three-branch decision (already-shared → direct; not-shared, no siblings → direct; not-shared, has siblings → a new three-way choice dialog). The choice dialog is a new store + Svelte component pair mirroring the existing `confirmDialog.ts`/`ConfirmDialog.svelte` pattern, sized for three outcomes (Cancel / Just this document / Share whole workspace) instead of two.

**Tech Stack:** TypeScript, Svelte 5, Vitest.

## Global Constraints

- The three-way choice only appears when the workspace is **not already shared** and has more than one document — an already-shared workspace always shares directly, regardless of document count (this is also the bug fix; see spec's Problem section).
- "Just this document" must behave identically to today's only behavior: isolate into a new workspace via `createWorkspace` + `moveDocToWorkspace`, then share that.
- "Share whole workspace" must not create or move anything — it shares the active document's existing `workspaceId` as-is.
- The document count shown in the dialog is the *total* count in the workspace (including the active document itself) — matches how the existing code already computes `siblingCount` (a filter that includes the doc being checked).

---

### Task 1: `decideShareTarget` pure function

**Files:**
- Modify: `client/src/collab.ts`
- Test: `client/src/collab.test.ts` (new)

**Interfaces:**
- Consumes: `Doc`, `Workspace` types from `./types` (not yet imported in this file — `collab.ts` currently only imports `AccessRecord` from `./types`).
- Produces:
  ```ts
  export interface ShareDirectDecision {
    kind: "direct";
  }
  export interface ShareChoiceDecision {
    kind: "choice";
    docName: string;
    workspaceName: string;
    docCount: number;
  }
  export type ShareDecision = ShareDirectDecision | ShareChoiceDecision;
  export function decideShareTarget(doc: Doc, docs: Doc[], workspaces: Workspace[]): ShareDecision;
  ```

- [ ] **Step 1: Write the failing test**

Create `client/src/collab.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { decideShareTarget } from "./collab";
import type { Doc, Workspace } from "./types";

function fakeDoc(overrides: Partial<Doc>): Doc {
  return { id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}
function fakeWorkspace(overrides: Partial<Workspace>): Workspace {
  return { id: "w1", name: "Workspace", createdAt: 0, ...overrides };
}

describe("decideShareTarget", () => {
  it("shares directly when the workspace is already shared, even with siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", shared: true })];
    expect(decideShareTarget(doc, docs, workspaces)).toEqual({ kind: "direct" });
  });

  it("shares directly when the workspace is already shared and has no siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const workspaces = [fakeWorkspace({ id: "w1", shared: true })];
    expect(decideShareTarget(doc, [doc], workspaces)).toEqual({ kind: "direct" });
  });

  it("shares directly when not shared and the doc has no siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const workspaces = [fakeWorkspace({ id: "w1" })];
    expect(decideShareTarget(doc, [doc], workspaces)).toEqual({ kind: "direct" });
  });

  it("returns a choice decision when not shared and the doc has siblings", () => {
    const doc = fakeDoc({ id: "d1", name: "My Notes", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" }), fakeDoc({ id: "d3", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", name: "My Workspace" })];
    expect(decideShareTarget(doc, docs, workspaces)).toEqual({
      kind: "choice",
      docName: "My Notes",
      workspaceName: "My Workspace",
      docCount: 3,
    });
  });

  it("falls back to placeholder names if the doc/workspace name is empty", () => {
    const doc = fakeDoc({ id: "d1", name: "", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", name: "" })];
    const result = decideShareTarget(doc, docs, workspaces);
    expect(result).toEqual({ kind: "choice", docName: "Untitled", workspaceName: "Untitled workspace", docCount: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/collab.test.ts`
Expected: FAIL — `decideShareTarget` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `client/src/collab.ts`, change the type import (line 21) from:

```typescript
import type { AccessRecord } from "./types";
```

to:

```typescript
import type { AccessRecord, Doc, Workspace } from "./types";
```

Add the new function directly above `export async function openShareModal()`:

```typescript
export interface ShareDirectDecision {
  kind: "direct";
}
export interface ShareChoiceDecision {
  kind: "choice";
  docName: string;
  workspaceName: string;
  docCount: number;
}
export type ShareDecision = ShareDirectDecision | ShareChoiceDecision;

// Being already-shared always wins over sibling count: opening a second
// document in a workspace collaborators are already synced to must never
// re-trigger the isolate-into-a-new-workspace prompt (that would
// incorrectly split it back out). Only an unshared workspace with more
// than one document needs a real choice between sharing just the active
// document (today's only behavior) or the whole workspace as-is.
export function decideShareTarget(doc: Doc, docs: Doc[], workspaces: Workspace[]): ShareDecision {
  const workspace = workspaces.find((w) => w.id === doc.workspaceId);
  if (workspace?.shared) return { kind: "direct" };
  const docCount = docs.filter((d) => d.workspaceId === doc.workspaceId).length;
  if (docCount <= 1) return { kind: "direct" };
  return {
    kind: "choice",
    docName: doc.name || "Untitled",
    workspaceName: workspace?.name || "Untitled workspace",
    docCount,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/collab.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/collab.ts client/src/collab.test.ts
git commit -m "feat: add decideShareTarget, fix already-shared workspace re-isolating"
```

---

### Task 2: Share-choice store

**Files:**
- Create: `client/src/stores/shareChoice.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ShareChoiceResult = "cancel" | "document" | "workspace";
  export interface ShareChoiceRequestState {
    docName: string;
    workspaceName: string;
    docCount: number;
    resolve: (choice: ShareChoiceResult) => void;
  }
  export const shareChoiceRequest: Writable<ShareChoiceRequestState | null>;
  export function shareChoice(docName: string, workspaceName: string, docCount: number): Promise<ShareChoiceResult>;
  ```

- [ ] **Step 1: Write the file**

Create `client/src/stores/shareChoice.ts`:

```typescript
// Presentational state for ShareChoiceModal.svelte — a three-way variant
// of stores/confirmDialog.ts's confirmRequest/confirmAction pattern.
// Cancel + one action isn't enough here: sharing a document that has
// siblings needs a real choice between "just this document" and "the
// whole workspace", not a single yes/no.
import { writable } from "svelte/store";

export type ShareChoiceResult = "cancel" | "document" | "workspace";

export interface ShareChoiceRequestState {
  docName: string;
  workspaceName: string;
  docCount: number;
  resolve: (choice: ShareChoiceResult) => void;
}

export const shareChoiceRequest = writable<ShareChoiceRequestState | null>(null);

export function shareChoice(docName: string, workspaceName: string, docCount: number): Promise<ShareChoiceResult> {
  return new Promise((resolve) => {
    shareChoiceRequest.set({ docName, workspaceName, docCount, resolve });
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean (nothing consumes this file yet, but it must compile standalone).

- [ ] **Step 3: Commit**

```bash
git add client/src/stores/shareChoice.ts
git commit -m "feat: add shareChoice store for the three-way share dialog"
```

---

### Task 3: ShareChoiceModal component

**Files:**
- Create: `client/src/components/ShareChoiceModal.svelte`
- Modify: `client/index.html` (mount div), `client/src/main.ts` (mount call)

**Interfaces:**
- Consumes: `shareChoiceRequest` (Task 2), `Modal.svelte`'s existing props (`title`, `icon`, `wide`, `labelledBy`, `onClose`, `elevated`, `footer` snippet — same set `ConfirmDialog.svelte` already uses).
- Produces: nothing new consumed elsewhere — this is a leaf UI component driven entirely by the Task 2 store.

- [ ] **Step 1: Create the component**

Create `client/src/components/ShareChoiceModal.svelte`:

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import { shareChoiceRequest, type ShareChoiceResult } from "../stores/shareChoice";

  function respond(choice: ShareChoiceResult) {
    $shareChoiceRequest?.resolve(choice);
    shareChoiceRequest.set(null);
  }
</script>

{#if $shareChoiceRequest}
  <Modal title={`Share "${$shareChoiceRequest.docName}"?`} icon="icon-users" wide labelledBy="shareChoiceTitle" onClose={() => respond("cancel")} elevated>
    <div class="empty-state" style="padding: 12px 0 24px;">
      <svg class="empty-state-icon"><use href="#icon-users"></use></svg>
      <div class="empty-state-desc" style="margin-bottom: 0; margin-top: 16px;">
        This document is one of {$shareChoiceRequest.docCount} in "{$shareChoiceRequest.workspaceName}." Share just this document, or the whole workspace together?
      </div>
    </div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={() => respond("cancel")}>Cancel</button>
      <span class="spacer"></span>
      <button type="button" class="secondary-btn" onclick={() => respond("document")}>Just this document</button>
      <button type="button" class="primary-btn" onclick={() => respond("workspace")}>
        Share whole workspace ({$shareChoiceRequest.docCount})
      </button>
    {/snippet}
  </Modal>
{/if}
```

- [ ] **Step 2: Add the mount point**

In `client/index.html`, find `<div id="confirm-dialog-mount"></div>` and add right after it:

```html
<!-- Share-whole-workspace choice — Svelte component, mounted in main.ts;
     see client/src/components/ShareChoiceModal.svelte -->
<div id="share-choice-modal-mount"></div>
```

In `client/src/main.ts`, add the import next to `ConfirmDialog`'s:

```typescript
import ShareChoiceModal from "./components/ShareChoiceModal.svelte";
```

and the mount call next to `ConfirmDialog`'s:

```typescript
mount(ShareChoiceModal, { target: document.getElementById("share-choice-modal-mount")! });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ShareChoiceModal.svelte client/index.html client/src/main.ts
git commit -m "feat: add ShareChoiceModal component"
```

---

### Task 4: Wire the decision into openShareModal

**Files:**
- Modify: `client/src/collab.ts`

**Interfaces:**
- Consumes: `decideShareTarget` (Task 1), `shareChoice` (Task 2).

- [ ] **Step 1: Add the import**

In `client/src/collab.ts`, add to the imports (near `import { confirmAction } from "./stores/confirmDialog";`):

```typescript
import { shareChoice } from "./stores/shareChoice";
```

- [ ] **Step 2: Replace openShareModal's body**

Find the existing `openShareModal` function:

```typescript
export async function openShareModal() {
  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) {
    window.MDE.requireGithubSignIn("Sharing needs a connected GitHub account. Sign in to continue.");
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;

  const siblingCount = get(docsStore).filter((d) => d.workspaceId === doc.workspaceId).length;
  let targetWorkspaceId = doc.workspaceId;
  if (siblingCount > 1) {
    const confirmed = await confirmAction(
      "Move to its own workspace?",
      "Sharing this document moves it into its own workspace so it can be shared. Continue?",
      "Continue",
      false
    );
    if (!confirmed) return;
    const ws = createWorkspace(doc.name || "Untitled");
    moveDocToWorkspace(doc.id, ws.id);
    targetWorkspaceId = ws.id;
  }

  shareModalOpen.set(true);
  currentAccess = await fetchWorkspaceAccess(targetWorkspaceId);
  syncShareStores();
}
```

Replace it with:

```typescript
export async function openShareModal() {
  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) {
    window.MDE.requireGithubSignIn("Sharing needs a connected GitHub account. Sign in to continue.");
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;

  let targetWorkspaceId = doc.workspaceId;
  const decision = decideShareTarget(doc, get(docsStore), get(workspacesStore));
  if (decision.kind === "choice") {
    const choice = await shareChoice(decision.docName, decision.workspaceName, decision.docCount);
    if (choice === "cancel") return;
    if (choice === "document") {
      const ws = createWorkspace(doc.name || "Untitled");
      moveDocToWorkspace(doc.id, ws.id);
      targetWorkspaceId = ws.id;
    }
    // choice === "workspace": targetWorkspaceId stays doc.workspaceId — share the whole workspace as-is.
  }

  shareModalOpen.set(true);
  currentAccess = await fetchWorkspaceAccess(targetWorkspaceId);
  syncShareStores();
}
```

- [ ] **Step 3: Remove the now-unused import**

`confirmAction` from `./stores/confirmDialog` was only used inside the code just replaced. Remove its import line:

```typescript
import { confirmAction } from "./stores/confirmDialog";
```

Run `grep -n "confirmAction" client/src/collab.ts` first to confirm there are truly zero remaining references before deleting the import — if any other call site exists, leave the import and skip this step.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all pass, including Task 1's 5 new tests.

- [ ] **Step 6: Manual verification**

Run the dev server (`npm run dev:client` is sufficient for this UI-only check — no backend calls happen before the Share modal itself would open, which needs a real session and isn't part of this manual check). Create a workspace with 3+ documents, open one, click Share:
- Confirm the three-way dialog appears with the correct document name, workspace name, and count in "Share whole workspace (N)".
- Click "Just this document" — confirm it isolates into a new workspace (same as today's behavior).
- Reopen a multi-doc workspace's Share flow, click "Share whole workspace (N)" — confirm the Share dialog opens for the *original* workspace, not a new one (no new workspace appears in the switcher).
- Click Cancel — confirm nothing happens (no dialog, no workspace change).

- [ ] **Step 7: Commit**

```bash
git add client/src/collab.ts
git commit -m "feat: wire share-whole-workspace choice into openShareModal"
```

---

## Final Verification

After all tasks complete:

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
npm run build
```

Expected: all tests pass, both typechecks clean, build succeeds.
