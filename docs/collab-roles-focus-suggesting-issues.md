# Collaboration roles, focus mode & suggesting-mode issues

Raw backlog captured 2026-09-08 from a manual pass over a shared/viewed
workspace, benchmarked against Google Docs' viewing / suggesting / editing
modes. Nothing here is scheduled yet — this is the triage input for a
future brainstorm → spec → plan cycle (per `CLAUDE.md`). The Google Drive
integration (`feat/google-drive-sync`, 5 plans) is unaffected and continues.

Reference behaviour the user is benchmarking against: Google Docs'
mode switcher (Editing / Suggesting / Viewing) top-right, its
right-margin suggestion cards, and the fact that Viewing mode hides
comments and the suggestion UI entirely.

---

## Group A — Role-based access control gaps

Roles today: owner → `editor`; link role or per-invite → `viewer` /
`reviewer` (suggester) / `editor`. `authorize()` resolves it server-side;
`collab.ts` mirrors it into the UI as best-effort UX.

- **A1 (#2)** — Publish to Gist / repo must be disabled for `viewer` and
  `reviewer` (suggester) roles. Currently reachable.
- **A2 (#3, open question)** — Should `editor` (non-owner) have Publish to
  Gist / push-to-repo at all? Undecided. Leaning: repo/Gist publishing is
  an owner-only action; editors edit content, they don't control the
  document's external publishing targets. Needs a decision.
- **A3 (#8)** — Viewer mode: hide (not just disable) the Edit / Format /
  Insert menus. Match Google Docs, which drops editing chrome in Viewing.
- **A4 (#15)** — Viewer mode: no access to comments at all — hide the
  comments panel + toggle + inline highlights, like Google Docs Viewing.
- **A5 (#1)** — Shared users have no signal that a workspace/document is
  linked to a GitHub repo or Gist. Surface the link (read-only badge /
  Document Info row) so collaborators know sync is in play.

## Group B — Focus mode

- **B1 (#5)** — No affordance for exiting focus mode. Add a top hover
  toast (Chrome-fullscreen style): slides down from the top edge, auto-
  hides, reappears when the pointer hits the top of the viewport. Should
  state the exit key/gesture.
- **B2 (#6, open question)** — Focus mode currently dims paragraphs only
  on the editor side. Is that intended, or should the effect extend to
  the preview pane too? Needs a decision on scope.

## Group C — Viewer-mode UI

- **C1 (#7)** — In viewer mode there's no way to reach the sidebar. Add a
  floating button to open the document sidenav.
- (A3, A4 also viewer-mode — grouped under A.)

## Group D — Suggesting mode overhaul (the big one — needs its own brainstorm)

- **D1 (#9)** — Inline suggestion rendering looks broken/cramped. Move to
  a Google-Docs-style right-margin card model.
- **D2 (#10)** — Deleting your own just-inserted suggested text should
  remove the suggestion (and its card/message) entirely, not leave an
  "added X then deleted X" pair.
- **D3 (#11)** — Every edit should be its own message thread.
- **D4 (#12, needs brainstorm)** — Granularity. Google Docs aggressively
  splits on whitespace and produces card spam. Proposal: anchor a
  suggestion to a *line / span of text* rather than per-character or
  per-token. How to batch edits into one coherent suggestion without
  losing the ability to accept/reject independently is the core design
  question.
- **D5 (#13)** — The standalone "edit" icon on suggestions — unclear what
  it does. Fold suggestion actions into the comments thread UI the way
  Google Docs merges suggestion + comment into one card.
- **D6 (#14)** — Add the Editing / Suggesting / Viewing mode switcher
  (top-right dropdown), matching Google Docs. Ties into A3/A4/C1 since
  the chosen mode drives which chrome is visible. Note current behaviour:
  a `reviewer` is *forced* into suggesting; an `editor` could opt into
  suggesting or viewing voluntarily.

## Group E — Bugs

- **E1 (#4)** — Sidebar document rows are sometimes missing in a
  workspace that is **both repo-synced and shared**; you have to click a
  row several times before it navigates. **Root cause found
  (2026-09-08):** repo-sync creates docs with client-side ids and never
  registers them with the shared `WorkspaceRoom`, so the room's
  `MESSAGE_WORKSPACE_META` broadcast makes `applyWorkspaceMeta()` delete
  every repo-pulled doc (not in the server `docOrder`); the next pull
  re-creates them with fresh ids. A click during the churn hits
  `switchDoc()` with a stale id, which sets `activeId` to a dead id and
  then the `id === activeId` guard blocks further clicks. → repo-sync +
  sharing don't compose. Decision (user, 2026-09-08): **make them
  compose** — register repo docs with the room. Needs a short spec.

## Group F — Shared-workspace lifecycle & correctness (new, 2026-09-08)

- **F1** — Opening a shared link, the workspace name resolves to the
  literal "Shared workspace" instead of the real name. **Root cause
  found:** `seedWorkspaceForFirstShare()` seeds each doc's content +
  per-doc name but never pushes the *workspace's* name to the server
  (`WorkspaceRoom.name` stays `""`); `/access` and the meta broadcast
  both carry `""`, so `decideJoinTarget` falls back to "Shared
  workspace" and `applyWorkspaceMeta` never heals it. Small Phase-1 fix:
  `pushWorkspaceRename` in `seedWorkspaceForFirstShare` after join, plus
  optional heal-on-connect for already-shared workspaces. **In progress.**
- **F2** — Same root cause as F1, second symptom: the merge/separate
  prompt (`JoinWorkspaceModal`) when opening a link while you already
  have a local workspace reads *"Shared workspace is shared with you"* —
  the placeholder name leaking into modal copy. Fixed by F1.
- **F5** — Sharing a single-file workspace named the joiner's workspace
  after the *file*, not the workspace (`decideJoinTarget`'s single-doc
  branches used `validDocs[0].name`). Fixed alongside F1 —
  `decideJoinTarget` now prefers the real remote workspace name.
- **F3** — Deleting a shared workspace gives no warning that
  collaborators on the other side will lose access to its documents.
  Needs a confirm dialog spelling out the consequence for a shared
  workspace specifically.
- **F4** — A deleted shared workspace stays accessible to others via the
  existing link — local deletion never tears down / revokes the
  `WorkspaceRoom`. Deletion must revoke remote access (server-side:
  clear access record / close the room / return 404-gone on join).

---

## Rough shape for later

- **E1 / F1–F5** are a "shared-workspace correctness" cluster. F1 (+F2,
  F5) shipped as a standalone Phase-1 fix (PR #175, v1.48.9). E1, F3, F4
  go into a short spec — repo-sync↔sharing composition and
  shared-workspace deletion semantics (warn + revoke).
- **A1, A3, A4, C1, B1** are bounded role/UI fixes → could be one
  "collaboration mode chrome" spec + plan, with **D6** (the mode
  switcher) as the umbrella feature they all hang off.
- **A2, B2** are decisions to settle before speccing.
- **D1–D5** are a suggesting-mode redesign → its own brainstorm, its own
  spec, its own multi-plan implementation. Biggest item here.
