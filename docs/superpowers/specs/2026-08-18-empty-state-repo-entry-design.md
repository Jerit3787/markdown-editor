# Empty State Repo Entry — Design Spec

**TODO item 14.** A trivial, fully independent addition — the first of
four items in the "repo/workspace metadata chain" backlog group, split
out since it has no dependency on the other three. Items 7, 8, and 16
form their own separate chain (7 is the foundation, 8 and 16 build on
it) and get their own spec, starting from item 7, once this ships.

## Goal

The "No workspace yet" empty state offers a second way in, alongside
"New workspace": opening a GitHub repo directly as a workspace, reusing
the app's existing flow rather than making the user go find it in the
File menu first.

## Behavior

`client/index.html`'s `.empty-state-no-workspace` block gains a second
button, styled and positioned the same way the sibling
`.empty-state-has-workspace` block already offers multiple entry points
(`New document` / `Open from device` / `Open from GitHub Gist`):

```html
<div class="empty-state-inner empty-state-no-workspace">
  <img src="/logo.svg" width="52" height="52" alt="">
  <h1>No workspace yet</h1>
  <p>Create a workspace to start adding documents.</p>
  <div class="empty-state-actions">
    <button type="button" id="emptyNewWorkspaceBtn" class="primary-btn"><svg class="icon"><use href="#icon-plus"></use></svg> New workspace</button>
    <button type="button" id="emptyOpenRepoBtn" class="secondary-btn"><svg class="icon"><use href="#icon-github"></use></svg> Open from GitHub Repo</button>
  </div>
</div>
```

`client/src/app.ts`'s `initEmptyState()` wires the new button the same
way `emptyOpenGistBtn` already delegates to its corresponding File-menu
item, rather than calling `window.MDE.openRepoModal` directly:

```ts
document.getElementById("emptyOpenRepoBtn").addEventListener("click", () => {
  document.getElementById("menuOpenRepo").click();
});
```

This is deliberately a delegation to the existing menu item's click
handler (`MenuBar.svelte`'s `#menuOpenRepo`, which already calls
`window.MDE.openRepoModal?.()`), matching the established pattern for
every other empty-state button in this same function — not a second,
parallel call path to `window.MDE.openRepoModal`.

No guard is needed: "Open GitHub Repo as Workspace" is a Tier 1,
always-available, workspace-creating action (per this session's earlier
workspace-gated-actions design) — it's precisely the action this empty
state exists to reach.

## Non-goals (deferred)

- Everything else in the "repo/workspace metadata chain" backlog group
  (items 7, 8, 16) — a separate, larger chain with its own decomposition,
  starting from item 7.

## Error handling

None new — delegates entirely to the existing, already-guarded
`#menuOpenRepo` click handler.

## Testing

No automated coverage — matches this codebase's established precedent
(no tests touch `index.html`'s static markup or `app.ts`'s DOM-wiring
functions). Manual verification: with a genuinely empty workspace list,
confirm the empty state shows both buttons, and that clicking "Open from
GitHub Repo" opens the same modal as File > Open > From GitHub Repo.
