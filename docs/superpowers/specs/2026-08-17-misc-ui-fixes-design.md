# Misc UI Fixes — Design Spec

**TODO items 9, 19.** Two small, unrelated UI bugs, fixed together since
each is tiny on its own. Root causes confirmed via
`superpowers:systematic-debugging`, including a live browser check to
settle an architectural question for item 9.

## Goal

Closing the Comments panel animates as cleanly as collapsing the sidebar
does — no visible shift/shadow glitch. The Version History panel's
Restore button is disabled when the currently-selected version is
already the document's current, active revision.

## Root causes

**Item 9.** `app.ts` toggles `#body`'s `comments-open` class the instant
`commentsPanelOpen` changes, the same tick `CommentsPanel.svelte`'s own
`class:collapsed` reactively toggles. `style.css` has `#body:not(.comments-open)
.comments-panel { grid-area: main; }` — a CSS Grid `grid-area`
reassignment, which cannot be animated. So the moment comments closes,
the panel's box jumps instantly to a different grid area while its
separate `margin-right`/`opacity` close transition (0.25s / 0.15s) is
still trying to animate in what's now the wrong position — the two
mechanisms fight, producing the reported glitch. `#sidebar` has no
equivalent reassignment; it stays permanently in the `sidebar` grid area
and only ever slides via `margin-left`, which is why it looks clean.

Verified live (via a real page load, toggling `#sidebar.collapsed` and
measuring `#main`'s `getBoundingClientRect()`): `#main`'s width and
position are **identical** before and after collapsing the sidebar
(1240px wide, starting at x=230 either way) — collapsing the sidebar
today is purely visual; the grid column stays reserved and `#main` never
reclaims that space. This settles the design question for the fix below:
matching the sidebar "identically" means the comments panel gives up its
current space-reclaiming behavior too, not just its animation smoothness.

**Item 19.** `VersionHistory.svelte`'s version list already marks the
first entry (`i === 0`) as `(current)` in the UI, but the Restore
button's `disabled` condition (`!selectedId || restoring ||
!restoreAllowed`) never checks whether `selectedId` actually is that
current version.

## Behavior

### 1. Comments panel closes like the sidebar (item 9)

`style.css`: `#body`'s `grid-template-areas` always includes the
`comments` track — the `#body.comments-open` variant is removed, and the
base rule gains the `comments` column permanently:

```css
#body {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-rows: auto 1fr;
  grid-template-areas:
    "toolbar toolbar view-selector"
    "sidebar main    comments";
  min-height: 0;
}
```

The now-unnecessary reassignment rule is deleted:

```css
#body:not(.comments-open) .comments-panel {
  grid-area: main;
}
```

`.comments-panel`'s transition simplifies to match `#sidebar`'s exactly —
one property, no opacity/visibility:

```css
.comments-panel {
  transition: margin-right 0.15s ease;
}

.comments-panel.collapsed {
  margin-right: -321px; /* 320px width + 1px border */
}
```

`app.ts`'s `commentsPanelOpen.subscribe(...)` callback that toggles
`#body`'s `comments-open` class is removed entirely, along with the class
itself — nothing reads it anymore once the grid-area reassignment and its
only other consumer are both gone.

Mobile (`@media (max-width: 780px)`) is unaffected — both `#sidebar` and
`.comments-panel` already use `position: fixed` there, bypassing the grid
entirely (confirmed: `#body`'s mobile `grid-template-areas` already omits
`comments`/`sidebar`).

### 2. Restore button disables on the current revision (item 19)

`VersionHistory.svelte`'s Restore button gains one more condition:

```svelte
<button type="button" class="primary-btn" disabled={!selectedId || restoring || !restoreAllowed || selectedId === versions[0]?.id} onclick={restore}>
  Restore this version
</button>
```

## Non-goals (deferred)

- **Reclaiming the freed space for `#main` when the comments panel
  closes.** This spec deliberately removes that behavior to match the
  sidebar's own (already-accepted) simpler model — a genuinely different
  "make the sidebar ALSO reclaim space" feature is out of scope here and
  would need its own design if wanted later.

## Error handling

Neither change introduces a new failure mode — item 9 is a pure CSS/JS
simplification (removing code, not adding new logic), and item 19 is one
more boolean condition on an already-guarded button.

## Testing

- No automated coverage for either change — matches this codebase's
  established precedent (no Svelte component tests, no CSS/visual
  regression tests). Manual verification: open and close the Comments
  panel repeatedly and confirm no visible shift/shadow glitch, and that
  it looks/feels identical to toggling the sidebar; open Version History
  on a document with edit history, confirm the entry marked "(current)"
  has a disabled Restore button when selected, and that selecting any
  other (older) version enables it normally.
