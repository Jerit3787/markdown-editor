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

## Group E — Bug

- **E1 (#4)** — Sidebar wikilink/reference targets are sometimes missing;
  you have to click an entry several times before the link "sets," then
  it navigates. Intermittent. Candidate for systematic-debugging — needs
  a reliable repro (which sidebar list, fresh load vs after edit, shared
  vs local).

---

## Rough shape for later

- **E1** is a bug → systematic-debugging, standalone, likely Phase 1.
- **A1, A3, A4, C1, B1** are bounded role/UI fixes → could be one
  "collaboration mode chrome" spec + plan, with **D6** (the mode
  switcher) as the umbrella feature they all hang off.
- **A2, B2** are decisions to settle before speccing.
- **D1–D5** are a suggesting-mode redesign → its own brainstorm, its own
  spec, its own multi-plan implementation. Biggest item here.
