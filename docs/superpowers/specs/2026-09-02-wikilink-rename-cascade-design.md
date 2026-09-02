# Wikilink Rename Cascade — Design Spec

## Goal

Renaming a document should keep every `[[OldName]]` reference to it,
anywhere the renaming user can see, pointing at the new name instead of
silently breaking.

## Root cause

`renameDoc()` (`client/src/stores/docs.ts`) only ever changes the
renamed document's own `name` field. Nothing scans other documents'
content for `[[OldName]]` occurrences, so every existing reference is
left pointing at a name that no longer resolves —
`resolveWikilinkTarget()`'s exact-match lookup (`d.name === name`)
simply fails for it from that point on, and the preview link/backlinks
panel treat it as pointing at a document that doesn't exist. This has
been true since wikilinks shipped (v1.15.0) and is called out explicitly
in ROADMAP.md's backlog.

Wikilink resolution and the `[[`-autocomplete menu are both global —
they search every document in `docsStore` across every workspace, not
just the active one (consistent with the app's existing global
document-name-uniqueness invariant). A complete fix therefore has to
reach documents outside the workspace being edited, including a
document that lives in a *different* shared workspace the renaming
user isn't currently connected to.

For a shared document, `docsStore`'s cached `content` field is not the
source of truth once that workspace isn't the live one — the real
content lives in that workspace's `WorkspaceRoom` Durable Object.
Writing straight to the local cache for such a document risks a silent
lost update the next time it reconnects and pulls the DO's real
content over it. Version History's "restore" feature already solves
the identical problem (`handleVersionRestoreContentRequest` in
`src/workspace-room.ts` patches the DO's Y.Text directly over an
authenticated HTTP endpoint, editor-role gated) — this spec reuses that
pattern rather than inventing a new one.

## Non-goals / deferred scope

- **No cascade on a remote-triggered rename.** When a collaborator
  renames a shared document, every other connected client receives it
  through `collab.ts`'s `metaMap` observer → `window.MDE.setDocName`.
  That path never triggers a cascade — only the client that actually
  performed the rename runs it, once, right after the name is
  committed. This avoids every connected collaborator redundantly
  racing to rewrite the same references.
- **No wikilink aliasing.** `[[Name|Display Text]]` doesn't exist yet
  (see ROADMAP.md), so there's no alias form to preserve during a
  rewrite.
- **No case-insensitive matching.** Matches the existing exact-match
  resolution rule (`resolveWikilinkTarget`) — `[[foo]]` is not touched
  by renaming a document named "Foo".
- **No special Version History treatment.** A cascade edit is an
  ordinary content change; it's captured by the existing
  time/session-based automatic snapshotting like any other edit, not
  forced into an immediate snapshot the way a version *restore* is.
- **No cascade for a document the renaming user can't edit.** A shared
  document in a workspace where the current user isn't an `editor`
  (viewer/reviewer, or no access at all) is silently skipped and stays
  stale — identical to today's status quo for that document, just not
  improved by this feature. Never surfaced as an error.
- **No AST-aware matching.** The rewrite is a plain regex pass over raw
  content, same as `transformWikilinks`/`findBacklinks` already are —
  a `[[Name]]`-shaped string sitting inside a fenced code block still
  gets rewritten, exactly as it would already render as a live link
  today. Not a new inconsistency, just an existing one preserved.

## Shared rewrite primitive

New files, both minimal and framework-agnostic, following the
`version-grouping.ts` precedent for logic needed identically on both
sides (kept in sync by hand, each with its own test file):

- `client/src/wikilink-rewrite.ts`
- `src/wikilink-rewrite.ts` (Worker copy — no import from either side's
  own `Doc`/`Env` types, so it has zero dependency on which project
  it's compiled under)

```ts
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

// Exact-match replace-all: only a fence whose captured name is
// *exactly* oldName is touched, same equality rule
// resolveWikilinkTarget already uses for resolution.
export function rewriteWikilinkReferences(content: string, oldName: string, newName: string): string {
  return content.replace(WIKILINK_RE, (match, name: string) => (name === oldName ? `[[${newName}]]` : match));
}
```

`client/src/wikilink-rewrite.ts` additionally exports (client-only —
the Worker copy never needs character ranges, only the final string):

```ts
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

`client/src/wikilinks.ts` still owns
`transformWikilinks`/`resolveWikilinkTarget`/`findBacklinks` (one small
change to the last of those, below) — the new file is a sibling, not a
replacement, kept separate specifically so the Worker copy can be
duplicated without dragging in `./types`'s `Doc` import.

## `client/src/wikilinks.ts` change

`findBacklinks`'s `excludeId` becomes optional (backward-compatible —
its one existing caller, `DocInfoPanel.svelte`'s backlinks list, keeps
passing it and is unaffected):

```ts
export function findBacklinks(targetName: string, docs: Doc[], excludeId?: string): Doc[] {
  const needle = `[[${targetName}]]`;
  return docs.filter((d) => d.id !== excludeId && d.content.includes(needle));
}
```

The cascade calls it with no `excludeId` at all — see below for why.

## `client/src/wikilink-rename-cascade.ts` (new)

Owns planning and orchestration. No CodeMirror import — reaches the
live editor only through a new `window.MDE` hook (see below), matching
the existing MDEBridge convention that anything needing `app.ts`'s
closure goes through the bridge instead of a direct import.

**Why there's no generic "active document" bucket:** every rename in
this app is a rename of the currently *active* document — the toolbar
title field, `DocEditModal`, and `DocList`'s "Rename" action (which
switches to the target doc first) all operate on `getActiveDoc()`.
There is no UI path that renames a document other than the one
currently open. So "is this candidate doc the one just renamed" and
"is this candidate doc the active document" are the same question, and
the interesting case isn't some other doc happening to be active — it's
the renamed document containing a **self-reference**, `[[OldName]]`
somewhere in its own content, referring to its own old name. That case
needs the live editor (the true owner of an open document's content),
while every other affected document — by definition, since only one
document can ever be active — needs either a plain `docsStore` write or
the HTTP endpoint.

```ts
import type { Doc, Workspace } from "./types";
import { findBacklinks } from "./wikilinks";

export interface WikilinkRenamePlan {
  // Set only when the renamed document's own content contains a
  // self-referential [[OldName]] — needs the live editor, not a
  // docsStore write, since the renamed doc is always the open one.
  selfReferenceDoc: Doc | null;
  localTargets: Doc[]; // plain writes via docsStore
  sharedTargets: { doc: Doc; workspace: Workspace }[]; // need the HTTP endpoint
}

// Pure — no store reads, no network, no DOM. Takes exactly what it
// needs so it's trivially unit-testable. No excludeId passed to
// findBacklinks here (unlike DocInfoPanel's use of it) — the renamed
// doc's own content is a legitimate candidate, just routed
// differently below once found.
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

```ts
// Reads the live stores, plans, applies every bucket, and returns how
// many documents actually changed (0 → caller shows no toast). A
// failure applying to one shared target never stops the others —
// each is independent and best-effort. Nothing here awaits before the
// selfReferenceDoc/localTargets handling, so it all runs synchronously
// in the same task as the rename commit — no risk of the active
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

## `stores/docs.ts` changes

New exported function, same shape as every other docsStore mutator in
this file:

```ts
// Rewrites [[oldName]] -> [[newName]] in one local (non-shared, non-
// active) document's content. Returns whether anything actually
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

## `app.ts` changes

New `window.MDE` bridge method, implemented where `cm` (the live
`EditorView`) is in scope:

```ts
// Rewrites every exact [[oldName]] occurrence in the ACTIVE document's
// live editor buffer to [[newName]], as one CodeMirror transaction (one
// undo step). If this document happens to be shared, the existing
// yCollab binding converts the transaction into a Y.Doc update and
// syncs it exactly like any other programmatic edit (e.g. a toolbar
// formatting command) — no special-casing needed here.
applyWikilinkRenameToActiveDoc(oldName, newName) {
  const content = cm.state.doc.toString();
  const occurrences = findWikilinkOccurrences(content, oldName);
  if (occurrences.length === 0) return false;
  cm.dispatch({ changes: occurrences.map((o) => ({ from: o.from, to: o.to, insert: `[[${newName}]]` })) });
  return true;
},
```

`commitActiveDocRename`'s no-collision branch (the only place a rename
settles without ever opening `RenameCollisionModal`) gains one call
after the existing collision check:

```ts
function commitActiveDocRename(previousName: string) {
  if (!docTitleInput.value.trim()) {
    docTitleInput.value = "Untitled";
    resizeDocTitle();
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;
  const finalName = docTitleInput.value;
  if (finalName === previousName) return;
  const colliding = findCollidingDoc(doc.id, finalName);
  if (colliding) {
    renameCollision.set({ docId: doc.id, pendingName: finalName, previousName, collidingDocId: colliding.id });
    return;
  }
  void cascadeWikilinkRenameAndToast(doc.id, previousName, finalName);
}
```

`cascadeWikilinkRenameAndToast` is a small new local function (also
exposed on `window.MDE` for `RenameCollisionModal.svelte` to call — see
below) that awaits `runWikilinkRenameCascade` and shows a toast only
when the count is nonzero:

```ts
async function cascadeWikilinkRenameAndToast(docId: string, oldName: string, newName: string) {
  const count = await runWikilinkRenameCascade(docId, oldName, newName);
  if (count > 0) showToast(`Updated ${count} link${count === 1 ? "" : "s"} to "${newName}"`, "success");
}
```

## `RenameCollisionModal.svelte` changes

`replace()` and `saveAsSuffixed()` both finalize a real rename (from
`state.previousName` to `state.pendingName`/`suggestedName`) — each
gains one call to `window.MDE.cascadeWikilinkRenameAndToast(state.docId, state.previousName, <finalName>)`
right after `commitName(...)`. `cancel()` reverts to the previous name
(no actual rename happened), so it stays untouched.

`DocEditModal.svelte` needs no changes — it already reuses
`window.MDE.renameActiveDoc`/`commitActiveDocRename`, the same pair the
toolbar title field uses, so it inherits cascade behavior for free.
`DocList.svelte`'s "Rename" menu action needs no changes either — it
only focuses the title field; the actual rename still goes through the
same commit path.

## `src/workspace-room.ts` changes

New handler, same authorization/response shape as
`handleVersionRestoreContentRequest`, minus the forced snapshot (an
ordinary Y.Doc transaction on any origin other than `"restore"`
already flows through `handleDocUpdate`'s existing `maybeSnapshot`
call, so this doesn't need to force one):

```ts
// Rewrites [[oldName]] -> [[newName]] wherever it appears in this
// document's live content, computed against the DO's own authoritative
// text — never trusts a client-supplied "new content" wholesale, since
// the requesting client's own cached copy of a document it isn't
// actively viewing can be stale. Best-effort from the caller's
// perspective: a 403 here just means the cascade skips this one
// document rather than failing the whole rename.
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

Dispatched from `fetch()` alongside the existing `/docs/:id/versions/*`
routes:

```ts
const wikilinkRenameMatch = url.pathname.match(/\/docs\/([^/]+)\/wikilink-rename$/);
if (wikilinkRenameMatch) return this.handleWikilinkRenameRequest(request, wikilinkRenameMatch[1]!);
```

## `src/worker.ts` changes

New top-level route, same pattern as the existing
`WORKSPACE_DOC_VERSIONS_PATH`/`WORKSPACE_DOC_COMMENTS_PATH` routes —
matches on the outer `workspaceId`, forwards the whole request to the
`WorkspaceRoom` DO, which re-parses `docId` itself:

```ts
const WORKSPACE_DOC_WIKILINK_RENAME_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/wikilink-rename$/;
```

```ts
const workspaceWikilinkRenameMatch = url.pathname.match(WORKSPACE_DOC_WIKILINK_RENAME_PATH);
if (workspaceWikilinkRenameMatch) {
  const id = env.WORKSPACE_ROOM.idFromName(workspaceWikilinkRenameMatch[1]!);
  return env.WORKSPACE_ROOM.get(id).fetch(request);
}
```

## Client → Worker call

New small function, same fetch-and-swallow-errors shape as
`restoreSharedVersionContent` (`client/src/history.ts`) — added
alongside it since it's the same "talk to the Worker about a specific
doc's content" concern:

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

## Error handling / edge cases

- **Renaming a document with zero backlinks anywhere.** `findBacklinks`
  returns an empty list, the plan's three buckets are all empty, the
  cascade resolves to `0`, no toast — behaviorally invisible, matching
  today for the overwhelmingly common case.
- **A shared target's workspace is unreachable** (403 for no editor
  access, network failure, the workspace room itself erroring). Each
  `pushWikilinkRenameToSharedDoc` call independently swallows its own
  failure and simply doesn't count toward the total; every other target
  in the plan is unaffected.
- **The renamed document's self-reference is also treated as a shared
  target.** Can't happen — `planWikilinkRenameCascade` checks
  `doc.id === renamedDocId` first and buckets it as
  `selfReferenceDoc`, never falling through to the shared-workspace
  branch, regardless of whether the renamed document itself lives in a
  shared workspace.
- **Renaming back and forth rapidly / renaming while the collision
  modal is open.** Each commit point captures its own `previousName`
  before the rename it triggers, so two rapid renames each cascade
  independently and correctly against their own before/after pair —
  no shared mutable "last name" state to go stale.
- **A race between the cascade's server-side read and a concurrent
  edit to that same target document.** Accepted, matching the exact
  same window `handleVersionRestoreContentRequest` already has for
  version-restore — not solved further here.
- **`RenameCollisionModal`'s `cancel()`.** No cascade call — the name
  reverts to `previousName`, so nothing changed.

## Testing

- New `tests/client/src/wikilink-rewrite.test.ts` and
  `tests/src/wikilink-rewrite.test.ts`: exact-match replace-all
  (including a near-miss like `[[OldNameSuffix]]` staying untouched),
  no-op when the name doesn't appear, multiple occurrences in one
  string, and (client copy only) `findWikilinkOccurrences`'s ranges.
- New `tests/client/src/wikilink-rename-cascade.test.ts`: pure
  `planWikilinkRenameCascade` cases — a doc with no reference is never
  in any bucket; a doc with no self-reference leaves `selfReferenceDoc`
  null even when the renamed doc's id is present among candidates
  found via a *different* name that happens to collide (defensive,
  shouldn't be reachable given global uniqueness, but cheap to assert);
  the renamed document's own content containing `[[OldName]]` is
  bucketed as `selfReferenceDoc`, even when that document's workspace
  is shared (never falls through to `sharedTargets`); a shared
  workspace missing `remoteId` (never actually shared despite the flag,
  if that's reachable — same defensive posture as
  `syncRemoteDocContent`'s own checks) falls back to `localTargets`.
  Async orchestrator tests with `docsStore`/`workspacesStore` seeded
  and `window.MDE`/`fetch` mocked: total count matches actual changes,
  one shared target's fetch rejecting doesn't suppress others' counts.
- Extend `tests/client/src/stores/docs.test.ts` (existing file) for
  `rewriteWikilinksInLocalDoc`: rewrites and bumps `updatedAt`; no-op
  (no `updatedAt` bump, no `persistDocs` call) when the name doesn't
  appear.
- Extend `tests/src/workspace-room.test.ts` (existing file) for
  `handleWikilinkRenameRequest`: 401 signed-out, 403 non-editor
  (viewer/reviewer), 400 missing body fields, rewrites the room's live
  `ytext` and returns `changed: true`, returns `changed: false` without
  transacting when the name isn't present (assert no
  `handleDocUpdate`/broadcast side effect from a no-op).
- New `tests/e2e/local/wikilink-rename-cascade.spec.ts`: create two
  local documents with a `[[Name]]` link between them, rename the
  target via the toolbar title field, assert the referencing document's
  content updated and the toast appeared; a second case through
  `RenameCollisionModal`'s "Replace" action; a third case for a
  self-reference — a document containing `[[OwnOldName]]` referring to
  itself, renamed, asserting the open editor's own buffer updates in
  place.
- New case in `tests/e2e/collab/`: two connected sessions in the same
  shared workspace, one renames a document referenced by a second
  (background, not-open) document; assert the second session's copy of
  that document — once opened — shows the updated link, confirming the
  HTTP-endpoint path actually synced through the DO rather than only
  appearing to work in the renaming client's own local cache.

## Versioning

User-facing bug fix with real behavior change (links that used to
silently break now update automatically) → minor version bump with its
own What's New entry, category "Organization & Navigation" (matching
the original Wikilinks entry, v1.15.0).
