# Misc UI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closing the Comments panel animates as cleanly as collapsing the sidebar (no shift/shadow glitch), and the Version History panel's Restore button disables when the selected version is already the document's current revision.

**Architecture:** Two small, independent fixes. Item 9 removes a CSS Grid `grid-area` reassignment that fights the panel's own margin/opacity transition, and simplifies that transition to match `#sidebar`'s single-property pattern exactly. Item 19 adds one more condition to an already-guarded button's `disabled` expression.

**Tech Stack:** TypeScript, Svelte 5, CSS.

## Global Constraints

- Matching the sidebar "identically" (item 9) means the comments panel also gives up its current space-reclaiming behavior for `#main` when closed — verified live that the sidebar itself doesn't reclaim space either (`#main`'s width/position are identical, 1240px, collapsed or not).
- Mobile (`@media (max-width: 780px)`) is out of scope for item 9 — both panels already use `position: fixed` there, bypassing the grid entirely.
- No automated coverage for either change — matches this codebase's established precedent (no Svelte component tests, no CSS/visual regression tests).

---

### Task 1: Comments panel closes like the sidebar

**Files:**
- Modify: `client/src/style.css`
- Modify: `client/src/app.ts`

**Interfaces:**
- None — pure CSS/JS simplification, no new functions or exports.

- [ ] **Step 1: Make the `comments` grid track permanent**

In `client/src/style.css`, find:

```css
#body {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-rows: auto 1fr;
  grid-template-areas:
    "toolbar toolbar view-selector"
    "sidebar main    main";
  min-height: 0;
}

#body.comments-open {
  grid-template-areas:
    "toolbar toolbar view-selector"
    "sidebar main    comments";
}
```

Change to:

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

- [ ] **Step 2: Remove the now-unnecessary grid-area reassignment**

In `client/src/style.css`, find:

```css
.comments-panel {
  /* A real grid item in #body (see index.html), not a fixed-position
     overlay — the panel takes up genuine layout space, so opening it
     pushes #main's own content narrower/left instead of floating on top
     of it like a modal. Its column is shared with the view selector
     above it (see #body's grid-template-areas), so both stay the same
     width automatically. */
  grid-area: comments;
  width: 320px;
  flex-shrink: 0;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

#body:not(.comments-open) .comments-panel {
  grid-area: main;
}
```

Change to:

```css
.comments-panel {
  /* A real grid item in #body (see index.html), permanently in its own
     "comments" grid column (see #body's grid-template-areas) — not a
     fixed-position overlay floating on top of the content like a modal.
     Its column is shared with the view selector above it, so both stay
     the same width automatically. Always occupies this column, even
     while closed (.collapsed below slides it out of view via margin,
     the same way #sidebar's own column stays reserved while it's
     collapsed) — #main does not reclaim this space either way, matching
     #sidebar's existing behavior exactly. */
  grid-area: comments;
  width: 320px;
  flex-shrink: 0;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 3: Simplify the close transition to match `#sidebar`'s**

In `client/src/style.css`, find:

```css
/* Comments Panel */
.comments-panel {
  transition: margin-right 0.25s cubic-bezier(0.4, 0, 0.2, 1), visibility 0s 0s, opacity 0.15s ease;
  opacity: 1;
  visibility: visible;
}

.comments-panel.collapsed {
  margin-right: -321px; /* 320px width + 1px border */
  opacity: 0;
  visibility: hidden;
  transition: margin-right 0.25s cubic-bezier(0.4, 0, 0.2, 1), visibility 0s 0.25s, opacity 0.15s ease;
}
```

Change to:

```css
/* Comments Panel */
.comments-panel {
  transition: margin-right 0.15s ease;
}

.comments-panel.collapsed {
  margin-right: -321px; /* 320px width + 1px border */
}
```

- [ ] **Step 4: Remove the now-unused `comments-open` class toggle**

In `client/src/app.ts`, find this block inside `initSidebar()`:

```ts
    commentsPanelOpen.subscribe((open) => {
      document.getElementById("body")?.classList.toggle("comments-open", open);
    });

```

Delete it entirely (all four lines, including the trailing blank line) —
nothing reads the `.comments-open` class anymore after Steps 1-2.
`commentsPanelOpen` itself stays imported at the top of the file — it's
still used elsewhere (e.g. `commentsPanelOpen.set(false)` in the
mobile-sidebar-collapse handler), only this one `.subscribe(...)` call
goes away.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no automated coverage touches this CSS/JS directly).

- [ ] **Step 7: Manual verification**

With `npm run dev:client`, open a document, open Comments (File > Comments or the topbar icon), then close it — confirm no visible shift/shadow glitch, and that the close motion looks/feels identical to toggling the sidebar collapse. Confirm the editor's width does not change when Comments opens or closes (matches the sidebar's existing behavior — space is not reclaimed either way).

- [ ] **Step 8: Commit**

```bash
git add client/src/style.css client/src/app.ts
git commit -m "fix: close the comments panel with the same clean animation as the sidebar"
```

---

### Task 2: Disable Restore when viewing the current revision

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`

**Interfaces:**
- None — purely widens an existing button's `disabled` expression.

- [ ] **Step 1: Update the Restore button**

In `client/src/components/VersionHistory.svelte`, find:

```svelte
          <button type="button" class="primary-btn" disabled={!selectedId || restoring || !restoreAllowed} onclick={restore}>
            Restore this version
          </button>
```

Change to:

```svelte
          <button type="button" class="primary-btn" disabled={!selectedId || restoring || !restoreAllowed || selectedId === versions[0]?.id} onclick={restore}>
            Restore this version
          </button>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no automated coverage touches this component).

- [ ] **Step 4: Manual verification**

With `npm run dev:client`, open a document with at least one saved version, open Version History, and confirm the entry marked "(current)" has a disabled Restore button when selected (it's selected by default on open, per `loadVersions`' `selectVersion(doc, isShared, versions[0]!.id)` call). Select an older version and confirm Restore becomes enabled.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/VersionHistory.svelte
git commit -m "fix: disable Restore when the selected version is already current"
```

---

### Task 3: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated).

- [ ] **Step 4: Manual verification**

Both changes are verifiable with `npm run dev:client` alone — no GitHub auth or full stack needed:

- Open and close the Comments panel a few times — confirm clean, glitch-free animation matching the sidebar.
- Open Version History on a document with history, confirm Restore is disabled on the current version and enables when selecting an older one.
