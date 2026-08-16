# Share Whole Workspace — Design Spec

Small, self-contained enhancement to the already-shipped workspace-level
sharing feature (v1.21.0). Not part of the workspace-pivot's numbered
sub-projects — a UX gap found after shipping, not new infrastructure.

## Problem

The only way to share is `collab.ts`'s `openShareModal()`, triggered by
the topbar Share button. It operates on the *active document's*
workspace, but when that workspace has more than one document, it
unconditionally isolates the active document into a brand-new workspace
of its own before sharing — there is no way to share an existing
multi-document workspace with everything already in it intact. To get a
5-document workspace shared as one unit today, a user would have to
re-create it from scratch by sharing one document and then somehow
moving the other four into that new shared workspace by hand.

A related latent bug: the isolate-or-not decision is based purely on
"does the active document have siblings?" — it never checks whether the
document's workspace is *already shared*. Opening a second document in
an already-shared workspace and clicking Share re-triggers the isolate
prompt, which would incorrectly split that document back out of a
workspace collaborators are already synced to.

## Behavior

`openShareModal()`'s decision tree changes from a binary
(siblings → isolate, no siblings → share directly) to:

1. **Workspace already shared** (`Workspace.shared` is true) — share
   directly, exactly like today's no-siblings case. No dialog. This is
   the fix for the latent bug above: being already-shared always wins,
   regardless of sibling count.
2. **Not shared, no siblings** — share directly, unchanged from today.
3. **Not shared, has siblings** — show a three-way choice dialog instead
   of today's single confirm prompt:

   ```
   Share "<document name>"?

   This document is one of <N> in "<workspace name>." Share just
   this document, or the whole workspace together?

   [Cancel]   [Just this document]   [Share whole workspace (<N> docs)]
   ```

   - **Just this document** — today's existing behavior, unchanged:
     `createWorkspace` + `moveDocToWorkspace` isolate the active
     document into a new workspace, then share that.
   - **Share whole workspace (N docs)** — skip isolation entirely;
     share the active document's *current* workspace as-is, exposing
     every document already in it. The count in the button label is
     the confirmation — no separate second dialog.
   - **Cancel** — no-op, same as declining today's prompt.

Everything downstream of "which workspace ends up as `targetWorkspaceId`"
— `fetchWorkspaceAccess`, `shareModalOpen`, the Share dialog itself — is
unchanged. This is purely a decision-point change before that point.

## Components

- **`client/src/collab.ts`** (modify) — `openShareModal()` gains the
  three-branch logic above. The `siblingCount > 1` check is renamed in
  spirit to "not shared and has siblings"; the existing
  `confirmAction(...)` call for the isolate path is replaced with a call
  into the new choice dialog when that branch is reached.
- **New: `client/src/stores/shareChoice.ts`** — presentational state for
  the new dialog, mirroring `stores/confirmDialog.ts`'s
  `confirmRequest`/`confirmAction()` shape but with two resolvable
  actions instead of one:
  ```ts
  interface ShareChoiceRequest {
    docName: string;
    workspaceName: string;
    docCount: number;
    resolve: (choice: "cancel" | "document" | "workspace") => void;
  }
  export function shareChoice(docName: string, workspaceName: string, docCount: number): Promise<"cancel" | "document" | "workspace">;
  ```
- **New: `client/src/components/ShareChoiceModal.svelte`** — renders the
  three-button dialog, mirroring `ConfirmDialog.svelte`'s structure
  (built on the shared `Modal.svelte`, mounted once in `main.ts` next to
  `ConfirmDialog`'s own mount point). `ConfirmDialog` itself is not
  touched — its Cancel/one-action shape stays as-is for every other
  caller (delete confirmations, the images-manager delete, etc.); this
  is a separate, purpose-built component for the one three-way case,
  not a generalization of `ConfirmDialog`.

## Error Handling

No new failure modes — `fetchWorkspaceAccess`/the share network call are
unchanged from today. The only new client-side logic (deciding which
workspace to target) is a pure local branch with no I/O, so nothing here
can fail independently of the sharing call that already exists.

## Testing

- Unit tests for the new decision logic in `collab.ts` (extracted as a
  small pure function if it isn't already easily testable in place) —
  cases: already-shared with siblings (share directly, no dialog),
  already-shared with no siblings (share directly), not-shared no
  siblings (share directly, unchanged), not-shared with siblings and
  each of the three dialog choices.
- Manual verification in-browser: the three-way dialog renders with the
  correct document/workspace names and count; each button's outcome
  (isolate-and-share vs. share-as-is vs. cancel) matches its label.
