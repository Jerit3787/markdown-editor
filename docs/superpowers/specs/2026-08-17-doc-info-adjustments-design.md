# Document Info Adjustments — Design Spec

**TODO item 4.** Two independent, small adjustments to how document metadata
is displayed: a more granular relative-time ladder, and a new linked
repo/gist section in the Document info panel (`DocInfoPanel.svelte`).

## Goal

1. Relative dates currently jump straight from "Yesterday" to a bare
   "Aug 12" for anything two or more days old. Add the missing middle
   ground — "5d ago", "2w ago", "3mo ago" — so recent-but-not-today dates
   stay legible at a glance.
2. The Document info panel (File > Document info) shows created/edited
   timestamps, length, and backlinks, but nothing about whether the
   active document is synced to a GitHub repo or published as a Gist —
   even though both are already tracked on the `Doc` object
   (`repoPath`/workspace `repoLink`, `gistId`). Surface that.

## Non-goals (deferred)

- No changes to how repo/gist linking itself works (TODO items 3, 6, 7,
  10 cover related repo/gist UX separately).
- No new "last synced" timestamp display — `repoSha`/`gistFilename` stay
  internal sync-tracking fields, not shown to the user here.
- No changes to `Open Recent` or `Command Palette`'s layout — only the
  relative-time *string* they already render changes.

## Relative-time ladder

`formatRelativeTime(ts: number): string` in `client/src/app.ts` (exposed
as `window.MDE.formatRelativeTime`, used by `MenuBar.svelte`'s Open
Recent submenu, `CommandPalette.svelte`'s sublabels, and
`DocInfoPanel.svelte`) changes from:

```ts
function formatRelativeTime(ts: number) {
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < day) return "Today";
  if (diff < day * 2) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
```

to a fuller ladder:

- `< 1 day` → `"Today"`
- `< 2 days` → `"Yesterday"`
- `< 7 days` → `"{n}d ago"` (n = 2-6)
- `< 30 days` → `"{n}w ago"` (n = whole weeks, floor(days / 7), so 7-13
  days → "1w ago", 14-20 → "2w ago", etc.)
- `< 365 days` → `"{n}mo ago"` (n = whole months, floor(days / 30))
- `>= 365 days` → full date with year, e.g. `"Aug 12, 2024"` (the
  existing month/day format, with `year: "numeric"` added)

All three call sites keep calling the same function with no signature
change — this is a pure behavior change inside `formatRelativeTime`
itself, so `MenuBar.svelte`, `CommandPalette.svelte`, and
`DocInfoPanel.svelte` need no edits for this half of the work.

## Linked repo/gist section

New section in `DocInfoPanel.svelte`, placed after the existing
Created/Edited/Length rows and before the "Linked from" backlinks
section (a document's own identity/sync info reads naturally before
where other documents reference it).

```svelte
{#if doc.repoPath || doc.gistId}
  <div class="menu-section-label">Synced to</div>
  {#if doc.repoPath}
    {@const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId)}
    {#if workspace?.repoLink}
      <div class="doc-info-row">
        <span class="doc-info-primary">Repo</span>
        <a
          class="doc-info-secondary doc-info-link"
          href={`https://github.com/${workspace.repoLink.owner}/${workspace.repoLink.repo}/blob/${workspace.repoLink.branch}/${doc.repoPath}`}
          target="_blank"
          rel="noopener"
        >
          {workspace.repoLink.owner}/{workspace.repoLink.repo} — {doc.repoPath}
        </a>
      </div>
    {/if}
  {/if}
  {#if doc.gistId}
    <div class="doc-info-row">
      <span class="doc-info-primary">Gist</span>
      <a class="doc-info-secondary doc-info-link" href={`https://gist.github.com/${doc.gistId}`} target="_blank" rel="noopener">
        View on GitHub
      </a>
    </div>
  {/if}
{/if}
```

Notes:

- Kept every row as a `<div class="doc-info-row">` (matching
  Created/Edited/Length exactly), with the link as an inner `<a>` rather
  than making the row itself the link. CSS's `:last-of-type` matches
  per-tag-type — `.doc-info-row:last-of-type { border-bottom: none; }`
  (already in `style.css`) would stop correctly targeting the actual
  last row if some rows were `<a class="doc-info-row">` and others were
  `<div class="doc-info-row">` siblings; keeping the tag consistent
  avoids that.
- `doc.repoPath` is set on the *document*; the owner/repo/branch it
  belongs to lives on its *workspace*'s `repoLink` (see
  `client/src/types.ts` — this mirrors the existing split
  `repo-sync-ui.ts`'s `activeRepoLink()` already navigates). The inner
  `{#if workspace?.repoLink}` guards the case where `repoPath` is
  stale/orphaned (workspace since unlinked) — matches this codebase's
  existing pattern of leaving stale sync fields in place rather than
  actively clearing them elsewhere (see the `repoLink` field's own
  comment in `types.ts`).
- Link targets mirror the existing "View Gist" link already in
  `MenuBar.svelte` (`https://gist.github.com/${activeDoc?.gistId}`,
  `target="_blank" rel="noopener"`).
- `.doc-info-link` is a new class for the inner link's styling
  (underline-on-hover, accent color) — small CSS addition in
  `client/src/style.css`, distinct from `.doc-info-backlink-row` (a full
  button, not applicable here since these rows have a fixed label +
  value shape, not a list of clickable items).
- Whole section renders nothing when `doc.repoPath` and `doc.gistId` are
  both unset — same "nothing extra" behavior the backlinks section
  already has for an empty backlink list, just without even the section
  label (no "Synced to" label with nothing under it).

## Testing

- Unit test for the new `formatRelativeTime` ladder. `app.ts` doesn't
  currently have its own test file (it's the legacy vanilla-DOM entry
  point, per the file's own "Phase 3 of the migration plan" comment in
  `client/tsconfig.json`) — `formatRelativeTime` is a private function
  inside `initApp()`'s closure, not exported. Since this is a pure
  function of `(Date.now(), ts)` with no DOM dependency, extract it to a
  small standalone exported function in a new
  `client/src/relative-time.ts` (single-purpose file, mirrors this
  codebase's existing pattern of small focused modules like
  `doc-naming.ts`), re-exported/called from `app.ts`'s
  `window.MDE.formatRelativeTime` assignment. Test file
  `client/src/relative-time.test.ts` covers each ladder rung with a
  fixed "now" (via `vi.setSystemTime`), including the day/week/month
  boundary edges (e.g. 6 days vs. 7 days, 29 days vs. 30 days, 364 vs.
  365 days).
- No automated test for the `DocInfoPanel.svelte` section — this
  codebase's Svelte components aren't unit-tested (verified: no
  `*.svelte.test.ts` files exist anywhere in `client/src/components/`);
  UI changes are verified manually in-browser, per this project's
  established practice. Manual check: open Document info on a doc with
  a `repoPath` (linked workspace), on a doc with a `gistId` (published
  gist), and on a plain unlinked doc — confirm the section shows the
  right rows (or is absent) in each case, and that the links open the
  correct GitHub URLs.
