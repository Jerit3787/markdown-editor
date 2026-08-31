# Suggestion-Mode Collaboration — Design Spec

## Goal

Give shared documents Google Docs-style "Suggesting" behavior: a reviewer's
edits become tracked suggestions the document's editor can accept or reject,
instead of being either dropped (today) or committed directly. Bundled with
this: viewer mode becomes a true look-only mode with no edit surface at all.

## Non-goals / deferred scope

- Suggested formatting changes (bold/italic/etc.) — only text insertion and
  deletion are tracked as suggestions. Applying `**` around existing text is
  itself an insertion+deletion pair and is covered; a hypothetical
  "suggest making this bold without touching characters" is not.
- Suggesting structural changes to images, diagrams, or citations metadata —
  those remain editor-only, unchanged from today.
- Comment threads and suggestions are independent systems in this phase; a
  suggestion cannot have a comment thread attached to it (may be a natural
  follow-up, not required for parity with the backlog item).
- Any change to the `editor`/`owner` role's own behavior — an editor's edits
  are exactly as direct and immediate as they are today.

## Role model

The existing three roles (`viewer`, `reviewer`, `editor`) are unchanged in
name. `reviewer`'s meaning changes: instead of a read-only editor surface
plus commenting, a reviewer gets a fully live, typeable editor surface where
every insertion/deletion becomes a suggestion instead of a direct edit.
`editor` is unchanged. `viewer` becomes strictly look-only (see "Viewer mode"
below) — no edit surface, no comments, no suggestions, nothing that changes
document state.

## Data model

A new top-level Yjs type on each document's `Y.Doc`, alongside the existing
`ytext` (content), `imagesMap`, and `meta`:

```
suggestions: Y.Map<string, SuggestionEntry>
```

```ts
interface SuggestionEntry {
  kind: "insert" | "delete";
  author: string; // GitHub username, or the guest identity's display name
  createdAt: number;
  from: RelativePositionJSON; // Y.relativePositionToJSON(...)
  to: RelativePositionJSON;
}
```

`from`/`to` are Yjs relative positions (`Y.createRelativePositionFromTypeIndex`
on `ytext`), not plain character offsets — they're automatically kept correct
as other edits happen anywhere in the document, the same mechanism Yjs's own
awareness/cursor protocol already relies on. They're serialized via
`Y.relativePositionToJSON`/`Y.createRelativePositionFromJSON`, which produces
a plain JSON-safe object, so they can be stored directly as a `Y.Map` value
without needing to be a nested Yjs type themselves.

**Insert suggestion**: the suggested text is inserted into `ytext` for real
(a normal Yjs insert — it merges with concurrent edits from other
collaborators exactly like any other edit). The suggestion entry marks that
range as provisional.

**Delete suggestion**: the targeted range is *not* removed from `ytext`. The
suggestion entry marks the range as "proposed for deletion"; the characters
stay in the document, unresolved, until the suggestion is accepted or
rejected.

**Resolution** (four cases, all defined the same way — remove the
suggestion entry, and additionally touch `ytext` only when the outcome is
"this proposed insert didn't happen" or "this proposed delete did happen"):

| | Accept | Reject |
|---|---|---|
| **Insert** | remove suggestion entry (text stays) | remove suggestion entry, then really delete `[from, to)` |
| **Delete** | remove suggestion entry, then really delete `[from, to)` | remove suggestion entry (text stays) |

**Merging contiguous edits**: while a reviewer keeps typing immediately after
their own still-pending insertion (caret sits exactly at that suggestion's
live `to` position, same author, same suggestion still unresolved), new
characters extend the existing suggestion's `to` rather than creating a new
entry per keystroke. The same applies to extending a selection-delete
gesture. A new suggestion id is only created when the previous one is
resolved, a different author is involved, or the edit isn't contiguous with
an existing pending range.

## Client: editing behavior (`client/src/components/Editor.svelte`)

A new CodeMirror extension, gated on `binding.role === "reviewer"`, sits
between the user's keystrokes and the shared `ytext`. It intercepts the
CodeMirror transaction before it's forwarded to Yjs (`y-codemirror.next`'s
`yCollab` extension is what actually applies changes to `ytext` today; the
suggestion extension needs to run its own logic in the same
`EditorView.updateListener`/transaction-filter pipeline rather than replacing
`yCollab` outright) and, for each inserted or deleted range in that
transaction:

- **Insert**: let the character insertion apply to `ytext` normally (via the
  existing `yCollab` path), then create-or-extend a `suggestions` entry
  covering the newly inserted range (per the merging rule above).
- **Delete**: *prevent* the deletion from reaching `ytext` (block/undo just
  that part of the transaction), and instead create-or-extend a `suggestions`
  entry of kind `"delete"` covering the range that would have been removed.

**Rendering**: a `suggestionsField` `StateField<DecorationSet>`, modeled
directly on `Editor.svelte`'s existing `imageMarkerField` pattern (a
`StateEffect`-driven decoration set that maps through `tr.changes` on every
transaction, so ranges stay correctly positioned through local edits) plus a
Yjs observer on the `suggestions` map (so remote suggestion changes — a
different reviewer's pending edit, or an editor's accept/reject — update the
field too). For each live entry, resolve `from`/`to` via
`Y.createAbsolutePositionFromRelativePosition` against the current `ytext`
state and render:

- `kind: "insert"` → `Decoration.mark({ class: "cm-suggestion-insert" })`
  (underline, background tinted to the author's existing awareness color
  from `colorForUsername`/remote-cursor coloring).
- `kind: "delete"` → `Decoration.mark({ class: "cm-suggestion-delete" })`
  (strikethrough, same author-tinted background).

A `WidgetType` at the end of each range renders a small inline card
(author name, relative time, and action buttons) on hover/click:

- **Editor role**: ✓ Accept / ✗ Reject.
- **The suggestion's own author** (must still be connected as reviewer):
  Withdraw (same effect as reject for an insert, or as accept — i.e. "give
  up, keep the current state" — for a delete; either way it's just "make my
  own proposal go away without judging it").
- **Everyone else**: read-only info, no actions.

Accept/reject/withdraw all go through the same `resolveSuggestion(id,
outcome)` client function (used by both the editor's buttons and the
author's withdraw), which performs the corresponding `ytext`
delete-or-not from the table above, then deletes the `suggestions` map entry
— both as one local Yjs transaction so collaborators never observe an
intermediate state.

## Client: Preview pane (`client/src/components/Preview.svelte`,
`client/src/mmd-*.ts` pattern)

A new `transformSuggestions(raw, suggestions)` step joins the existing
raw-markdown-text transform pipeline (alongside `transformWikilinks`,
`transformCitations`, `extractMathSpans`, etc. — all of which already
rewrite the raw string before `marked.parse()` runs). For each live
suggestion, resolved to current absolute character offsets the same way the
editor's decoration field does:

- `kind: "insert"` → wrap the range in
  `<ins class="suggestion-insert" data-suggestion-id="…">…</ins>`.
- `kind: "delete"` → wrap the range in
  `<del class="suggestion-delete" data-suggestion-id="…">…</del>`.

`marked` passes raw inline HTML through by default, and `<ins>`/`<del>` are
already in DOMPurify's default allowlist (no `ADD_TAGS` changes needed). CSS
styles `<ins>` as an author-tinted underline and `<del>` as an author-tinted
strikethrough, mirroring the editor pane.

**Known limitation**: if a suggestion's boundary falls inside Markdown syntax
itself (e.g. a deletion removes only one `*` of a `**bold**` pair, or crosses
into/out of a fenced code block), Preview may render that one pending
suggestion's surrounding text oddly until it's resolved. This is inherent to
layering suggestions on top of a Markdown source-and-render pipeline rather
than a true rich-text model (why Google Docs itself has no equivalent
problem) — it never affects the editor pane (always correct) or the
suggestion's own eventual accept/reject outcome, only Preview's cosmetic
rendering while that one edit is still pending.

## Server: `WorkspaceRoom` (`src/workspace-room.ts`)

Today, `handleMessage`'s sync-message handling has:

```ts
const isWrite = syncType === SYNC_STEP2 || syncType === SYNC_UPDATE;
if (isWrite && session && session.role !== "editor") return; // read-only: drop silently
```

This becomes: `isWrite` from a `reviewer` session is now **allowed to
apply** (both `ytext` and `suggestions` map changes need to sync — a
reviewer must be able to actually type). `viewer` is unchanged (still
dropped outright — see "Viewer mode").

**Integrity enforcement** (the part that actually makes `reviewer`
meaningfully different from `editor`, not just "editor with client-side
theater"): after applying an update from a `reviewer` session, the server
reads the resulting change directly from Yjs's own transaction — a
`ytext.observe` callback's `YTextEvent.delta` gives the exact insert/delete
operations the update just applied, in document order, without needing to
diff full document strings (cheap regardless of document size, and
unambiguous about which characters actually changed, unlike a min-edit-
distance diff over before/after text which could describe the same result a
different way than what was actually typed). Any inserted or deleted range
from that delta which isn't already covered by a live `suggestions` entry
gets one created for it, server-side, right then — the server does not
trust the reviewer's client to have created it correctly, it verifies and
back-fills. This makes the guarantee "a reviewer's connection can never
leave the document with real, untracked content changes" hold regardless of
client behavior (a bug, or a modified client), the same posture this
codebase already takes for every other server-enforced role check.

Comment-thread endpoints (`handleCommentsRequest` etc.) are unchanged —
suggestions are a separate system in this phase (see non-goals).

## Client: viewer mode (`client/src/stores/view.ts`, `collab.ts`)

When a document is joined with `role === "viewer"`:

- The view mode is forced to `"preview"` and the View menu / view-selector's
  Editor and Split options are hidden entirely (nothing to switch to) rather
  than merely disabled.
- `window.MDE.setReadOnly` is unaffected (already true for any non-editor
  role) but becomes moot for viewers since the editor surface never mounts
  into view.
- No change to server-side comment gating — viewers remain blocked from
  commenting, exactly as today. "Look only, change nothing" applies to every
  document write path: content, comments, and suggestions alike.

## Supporting UX: pending-suggestion badge

Mirrors the existing unresolved-comment-count badge exactly
(`stores/commentsPanel.ts`'s `unresolvedCommentCount` /
`MenuBar.svelte`'s `.menu-badge` / `CommentsPanel.svelte`'s `#commentsBadge`
pattern): a new `pendingSuggestionCount` store, updated whenever the
`suggestions` Y.Map changes, shown as a badge on whatever UI entry point
suggestions get (a new topbar icon, or folded into the existing Comments
icon's neighborhood — left as an implementation-plan decision, not a design
fork). Visible to both `editor` (whose job is to resolve them) and
`reviewer` (to track their own pending suggestions) roles; not shown to
`viewer` (nothing for them to act on).

## Testing

- **Unit** (`tests/src/`, mirroring `workspace-room.test.ts`'s existing
  style): suggestion create/extend/accept/reject/withdraw against a real
  `Y.Doc`, including a case where a concurrent edit elsewhere in the
  document happens between a suggestion's creation and its resolution
  (proving the relative-position tracking holds). Server-side reconciliation
  logic: a correctly-suggestion-wrapped reviewer update passes through
  untouched; a raw, unwrapped reviewer update gets auto-wrapped.
- **Component** (`tests/client/src/components/`): the suggestion decoration
  rendering and its accept/reject/withdraw widget, mounted with
  `vitest-browser-svelte` the same way other Svelte components in this repo
  are tested.
- **Playwright e2e** (`tests/e2e/collab/`, since this is inherently a
  multi-role collaboration feature — needs the real `WorkspaceRoom` Durable
  Object, not a mocked one): a reviewer session types and deletes text,
  confirms decorations and Preview both render the suggestion; an editor
  session in a second browser context sees the same suggestion, accepts one
  and rejects another, confirms both sessions converge to the same final
  document; a viewer session confirms only Preview is visible, no
  editor pane, no comment ability.
