# Top-bar chrome v2 — design

**Status:** approved (brainstorm 2026-09-09)
**Follows:** the v1.54.0 top-bar chrome pass
(`docs/superpowers/specs/2026-09-08-topbar-chrome-design.md`) — this
fixes two bugs it left and finishes the account button / mode switcher
to Google-Docs parity, from live review feedback.
**Ships as:** one user-facing minor release (`1.56.0`).

## Goal

1. **Fix** the mode-switcher dropdown's broken layout (icons float above
   the text instead of beside it).
2. **Fix** the mode-switcher caret pointing **left** on mobile instead
   of down.
3. Give the mode-switcher button a **visible outline** (Google's is an
   outlined pill).
4. **Resize** the top-bar avatar to Google's model — a 32px image inside
   the 40px circular button, not filling it.
5. **Move Settings** off its own top-bar button and into the account
   menu.
6. **Redesign** the account dropdown — a proper header + divider +
   items.

## Non-goals / deferred

- **Refactoring the shared `.dropdown-item` / `.dropdown-menu button`
  rules in `_utilities.scss`.** The `display: block` that shadows
  `.dropdown-item`'s intended `display: flex` (root cause of bug 1) is
  real, but every menu in the app rides those rules — re-basing them is
  its own audit. This spec fixes the mode-switcher menu with a scoped,
  higher-specificity rule and notes the dead `display: flex` for a
  future cleanup.
- **A Settings entry in a menu bar menu** (File / Edit / Help). Settings
  moves to the account dropdown only.
- **Changing what Settings contains.** Its Connect / Disconnect GitHub
  section stays; the account menu's "Sign out" is a shortcut to the
  same `POST /api/auth/github/logout`.
- **Mobile-specific redesign of the account dropdown** beyond it
  rendering correctly at phone width.
- **Touching top-bar button sizes or accent tokens** beyond the two
  changes named here (avatar padding; a mode-switcher border) — per
  `feedback_topbar_sizing_locked`.

## Global constraints

- Two `tsconfig.json`s, checked separately. New client code under
  `client/src/`.
- Svelte 5 runes. Component tests → `tests/client/src/components/*.test.ts`
  (`components` Vitest project, real headless Chromium).
- `npm run format` + `npm run typecheck` must pass.
- Dark theme is the `[data-theme="dark"]` attribute selector — any new
  colour token defined under both `:root` and `[data-theme="dark"]` in
  `_variables.scss` (none expected here; `--border` already themed).
- User-facing → **minor** bump to `1.56.0`: `package.json` + both
  `package-lock.json` `"version"` fields; `## [1.56.0] - <date>`
  CHANGELOG section (`### Fixed` + `### Changed`); one
  `whats-new-entries.ts` entry with a real committed screenshot at
  `client/public/whats-new/topbar-chrome-v2.png`.
- `docs/TEST-COVERAGE.md` updated.

---

## Part 1 — Bug: mode-switcher dropdown layout

### Root cause

`client/src/styles/_utilities.scss`:

```scss
.dropdown-menu {
  button.dropdown-item {                 /* (0,2,1) */
    display: flex; align-items: center; gap: 8px;
  }
}
.dropdown-menu button.dropdown-item,
.dropdown-menu button:not(.primary-btn):not(.secondary-btn) {   /* (0,3,1) */
  display: block; width: 100%; text-align: left; padding: 9px 14px; …
}
```

Every `.dropdown-item` is also matched by
`.dropdown-menu button:not(.primary-btn):not(.secondary-btn)` (0,3,1),
which sets `display: block` and out-specifies the `display: flex` rule.
So `.dropdown-item` is `display: block` everywhere — harmless for a
plain `<svg> Text` row (both flow inline), but `ModeSwitcher`'s item is:

```svelte
<button class="mode-switcher-item dropdown-item" …>
  <svg class="icon">…</svg>
  <span class="mode-switcher-item-text">   <!-- display:flex; flex-direction:column -->
    <span class="mode-switcher-item-label">Editing</span>
    <span class="mode-switcher-desc">Edit document directly</span>
  </span>
</button>
```

`.mode-switcher-item-text` is a block-level flex container → it wraps
below the inline `<svg>`. Result: icon on line 1, two-line text block on
line 2. `_topbar.scss`'s `.mode-switcher-menu .mode-switcher-item {
align-items: flex-start }` is inert because the item isn't a flex box.

### Fix

`client/src/styles/_topbar.scss` — replace the inert rule with an
id-scoped one that beats the `(0,3,1)` `_utilities` rule:

```scss
#topbarActionsCol .mode-switcher-menu .mode-switcher-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
#topbarActionsCol .mode-switcher-menu .mode-switcher-item .icon {
  flex-shrink: 0;
  margin-top: 1px; /* optically centre the 18px glyph against the label line */
}
```

`#mode-switcher-mount` is inside `#topbarActionsCol`, so the menu is a
DOM descendant — the id selector applies. `.mode-switcher-item-text` and
`.mode-switcher-desc` rules stay as they are.

Leave a one-line comment in `_utilities.scss` above the offending rule:
`/* NOTE: this shadows .dropdown-item's own display:flex above — see
topbar-chrome-v2 spec; a broad fix is deferred. */`

### Acceptance

- Each mode row in the open dropdown reads: `[icon]  Label` on the first
  line, the grey description directly under the label, icon vertically
  aligned to the label — not above it.
- Desktop and mobile.

### Tests

- `ModeSwitcher.test.ts` — after opening the menu (editor role, 3
  modes), the first `.mode-switcher-item`'s computed `display` is
  `"flex"`, and the `.icon` and `.mode-switcher-item-text` share a row
  (`.icon`'s `offsetTop` is within a few px of the text block's
  `offsetTop`, not above it).

---

## Part 2 — Bug: mobile caret points left

### Root cause

`client/src/styles/_menu.scss`:

```scss
@media (max-width: 780px) {
  .menu-chevron { transform: rotate(90deg); }
}
@media (max-width: 780px) {
  .menu-submenu-trigger.active .menu-chevron { transform: rotate(-90deg); }
}
```

Intended only for the File/Edit/… submenu triggers (desktop `›` →
mobile `⌄`). `.menu-chevron` is unscoped, and `ModeSwitcher.svelte` uses
`class="icon menu-chevron"` for its dropdown caret (`#icon-chevron-down`).
On mobile that down-caret is rotated 90° → points left.

### Fix

Two independent changes (belt and braces):

1. `_menu.scss` — scope both mobile-rotation rules to the menu bar:
   ```scss
   @media (max-width: 780px) {
     #menuBar .menu-chevron { transform: rotate(90deg); }
   }
   @media (max-width: 780px) {
     #menuBar .menu-submenu-trigger.active .menu-chevron { transform: rotate(-90deg); }
   }
   ```
   Check the non-media `.menu-chevron` base rule (`margin-left: auto;
   width: 12px; opacity: 0.55`) — it is also `#menuBar`-only in intent;
   scope it to `#menuBar .menu-chevron` too so nothing else inherits
   `margin-left: auto` (which would shove the mode-switcher caret to the
   far edge). The mode switcher already overrides `width` at
   `_topbar.scss:348`; after this it needs its own `opacity` too (fold
   into the rename below).

2. `ModeSwitcher.svelte` + `_topbar.scss` — rename the caret's class
   from `menu-chevron` to `mode-switcher-caret` so it can never collide
   with menu-bar chevron styling again. Update
   `#topbarActionsCol .mode-switcher-btn .menu-chevron` →
   `#topbarActionsCol .mode-switcher-btn .mode-switcher-caret` and give
   it `width: 14px; height: 14px; opacity: 0.7`.

### Acceptance

- Mobile (≤780px): the mode-switcher caret points **down**.
- Desktop unchanged.
- File-menu submenu carets still rotate correctly on mobile
  (`menu-shell.spec.ts` / `mobile-menu-overflow.spec.ts` stay green).

### Tests

- `ModeSwitcher.test.ts` — the caret element has class
  `mode-switcher-caret`, not `menu-chevron`.
- e2e `tests/e2e/webkit/` (iPhone viewport) already exercises the mobile
  menu bar; add nothing there unless a caret-direction assertion is
  cheap — a computed-`transform` check on `.mode-switcher-caret` being
  `none` (or matrix identity) at mobile width, in a `--project=local`
  test with the viewport forced to 375px.

---

## Part 3 — mode-switcher button outline

### Change

`client/src/styles/_topbar.scss`, `#topbarActionsCol .mode-switcher-btn`:

```scss
#topbarActionsCol .mode-switcher-btn {
  width: auto;
  height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border: 1px solid var(--border);   /* NEW — Google's outlined pill */
  border-radius: 20px;
}
```

`.icon-btn`'s base is `border: none`; this id rule wins. Hover stays
`.icon-btn:hover { background: var(--border) }` — acceptable against the
1px border, but set an explicit `#topbarActionsCol .mode-switcher-btn:hover
{ background: var(--bg-alt); border-color: var(--text-dim); }` so the
hover reads as a button press, not a fill swap. Active/open state
(`[aria-expanded="true"]`) → `background: var(--accent-dim); border-color:
var(--accent); color: var(--accent);`.

### Acceptance

- The mode switcher renders as a bordered pill in both the icon+caret
  and icon+label states, light and dark themes, not an oval.
- Hover and open states are visually distinct from rest.

### Tests

- `ModeSwitcher.test.ts` — the button's computed `border-style` is
  `"solid"` (not `"none"`).

---

## Part 4 — account button + dropdown

### 4a. Avatar sizing

`client/src/styles/_topbar.scss`:

```scss
#topbarActionsCol .topbar-account-btn {
  width: 40px;
  height: 40px;
  padding: 4px;          /* was 0 */
  /* overflow: hidden removed — the avatar is inset and already round */
}
#topbarActionsCol .topbar-account-avatar {
  width: 100%;           /* = 32px content box */
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 50%;
}
```

The 40px circular `.icon-btn` hover fill still shows around the 32px
avatar — same weight as the neighbouring comments / history / settings
glyphs (18px in a 40px box).

### 4b. Move Settings into the account menu

**New store** `client/src/stores/settingsModal.ts`:

```ts
import { writable } from "svelte/store";
export const settingsModalOpen = writable(false);
```

**`Settings.svelte`:**
- Import `settingsModalOpen`; drive the modal off it:
  ```ts
  let hidden = $derived(!$settingsModalOpen);
  ```
  and `close()` becomes `settingsModalOpen.set(false)`.
- Remove the `document.getElementById("settingsBtn")?.addEventListener("click", open)`
  line and the now-unused `open()`.
- The Escape handler stays (it already reads `hidden`).

**`client/index.html`:** delete the
`<button id="settingsBtn" …>…</button>` from `.topbar-actions` (it sat
between the Share group and `#topbar-account-mount`).

**`TopbarAccount.svelte`:** add a `Settings` item to both menu branches;
`onclick` sets `settingsModalOpen.set(true)` (and closes the account
menu). Import the store.

**Test updates** (open Settings via the account menu instead of
`#settingsBtn`):
- `tests/e2e/local/keybindings.spec.ts` — 5 `page.click("#settingsBtn")`
  → a helper that clicks `.topbar-account-btn` then the `Settings`
  menuitem. The `local` suite is always signed-out, so the signed-out
  menu must carry `Settings`.
- `tests/e2e/local/preview-rendering.spec.ts:71` — same.
- `tests/e2e/local/topbar-chrome.spec.ts` — drop the `#settingsBtn`
  border-radius line (button no longer exists); the account button's
  circle is already covered.
- `tests/client/src/topbar-tooltip.test.ts` — remove `"settingsBtn"`
  from the migrated-ids list.

### 4c. Redesign the dropdown

`TopbarAccount.svelte` menu markup — signed in:

```svelte
<div class="dropdown-menu topbar-account-menu" role="menu" style="right: 0; min-width: 240px">
  <div class="topbar-account-header">
    <span class="topbar-account-header-avatar">
      {#if !imgFailed}
        <img src={`https://github.com/${$githubUsername}.png?size=64`} alt="" onerror={() => (imgFailed = true)} />
      {:else}
        <svg class="icon"><use href="#icon-user"></use></svg>
      {/if}
    </span>
    <span class="topbar-account-header-text">
      <span class="topbar-account-header-name">{$githubUsername}</span>
      <span class="topbar-account-header-sub">Signed in via GitHub</span>
    </span>
  </div>
  <div class="dropdown-divider"></div>
  <button type="button" role="menuitem" class="dropdown-item" onclick={openSettings}>
    <svg class="icon"><use href="#icon-settings"></use></svg> Settings
  </button>
  <button type="button" role="menuitem" class="dropdown-item" onclick={signOut}>
    <svg class="icon"><use href="#icon-log-out"></use></svg> Sign out
  </button>
</div>
```

Signed out — the button becomes a menu trigger too (not a direct
sign-in), opening:

```svelte
<div class="dropdown-menu topbar-account-menu" role="menu" style="right: 0; min-width: 240px">
  <div class="topbar-account-header">
    <span class="topbar-account-header-avatar"><svg class="icon"><use href="#icon-user"></use></svg></span>
    <span class="topbar-account-header-text">
      <span class="topbar-account-header-name">Not signed in</span>
      <span class="topbar-account-header-sub">Sign in to share &amp; publish</span>
    </span>
  </div>
  <div class="dropdown-divider"></div>
  <button type="button" role="menuitem" class="dropdown-item" onclick={signIn}>
    <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
  </button>
  <button type="button" role="menuitem" class="dropdown-item" onclick={openSettings}>
    <svg class="icon"><use href="#icon-settings"></use></svg> Settings
  </button>
</div>
```

Both branches now share one `<button class="topbar-account-btn">` that
`toggle()`s the menu. `signIn` / `signOut` / `openSettings` each close
the menu first. Keep `data-tooltip` = username (signed in) / `"Account"`
(signed out); keep `.tooltip-end`.

`_topbar.scss` — new rules:

```scss
.topbar-account-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
}
.topbar-account-header-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-alt);
}
.topbar-account-header-avatar img { width: 100%; height: 100%; object-fit: cover; }
.topbar-account-header-avatar .icon { width: 18px; height: 18px; color: var(--text-dim); }
.topbar-account-header-text { display: flex; flex-direction: column; min-width: 0; }
.topbar-account-header-name {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar-account-header-sub { font-size: 12px; color: var(--text-dim); }
```

`.dropdown-divider` already exists (used by `#shareDropdownMenu`). Drop
the old `.topbar-account-menu .menu-section-label` rule.

### Acceptance

- Signed in: click avatar → menu with the header (32px avatar + name +
  "Signed in via GitHub"), a divider, then **Settings** and **Sign
  out**. Settings opens the Settings modal; Sign out POSTs logout +
  reloads.
- Signed out: click person icon → menu with "Not signed in" header,
  **Sign in with GitHub** (→ popup) and **Settings**.
- Avatar image error → the `#icon-user` glyph in both the button and the
  header.
- No `#settingsBtn` in the top bar.
- Menu closes on outside-click / Escape / selecting an item.

### Tests (`tests/client/src/components/TopbarAccount.test.ts` — rewrite)

- signed in: renders the header name; the button (not a direct action)
  opens the menu; `Settings` item sets `settingsModalOpen` true;
  `Sign out` calls `fetch("/api/auth/github/logout", {method:"POST"})`.
- signed out: `Sign in with GitHub` calls
  `window.MDE.openGithubSignInPopup`; `Settings` item present and sets
  the store.
- `<img>` `error` event → `#icon-user` in the button.
- `settingsModalOpen` starts `false`.

Plus `Settings.svelte` gains a small component test (new
`tests/client/src/components/Settings.test.ts`): `settingsModalOpen.set(true)`
→ the modal (`getByText("Settings")` / a known field) renders;
`.set(false)` → gone. (Guard the existing "opened via #settingsBtn"
behaviour is fully replaced.)

---

## Release

- `package.json` + `package-lock.json` (both fields) → `1.56.0`.
- `CHANGELOG.md` `## [1.56.0] - <date>`:
  - `### Fixed` — mode-switcher dropdown layout; mobile mode-switcher
    caret direction.
  - `### Changed` — mode switcher is an outlined pill; the top-bar
    avatar is smaller; Settings moved into the account menu, which now
    has a proper header.
- `client/src/whats-new-entries.ts` — a `1.56.0` entry
  (`category: "Organization & Navigation"`, screenshot
  `/whats-new/topbar-chrome-v2.png`) + a real committed screenshot
  (capture script against a local signed-in build, account menu open).
- `docs/TEST-COVERAGE.md` — extend SHELL-26 (mode switcher) and SHELL-27
  (account button) rows; add the Settings-open row.
- `ROADMAP.md` — under the v1.54.0 "Google-Docs-style top bar" section,
  a short "v2 (v1.56.0)" note: the two bug fixes + outline + avatar +
  Settings-in-menu; link this spec.

## Implementation order (one commit each, TDD)

1. **Part 1** — mode-switcher dropdown `display: flex` fix + test.
2. **Part 2** — scope `.menu-chevron` mobile rotation to `#menuBar`;
   rename the mode-switcher caret class; tests.
3. **Part 3** — mode-switcher button outline + hover/open states + test.
4. **Part 4a** — avatar padding/sizing.
5. **Part 4b** — `settingsModal` store, `Settings.svelte` rewire, remove
   `#settingsBtn`, update the 4 test files.
6. **Part 4c** — account dropdown redesign markup + CSS + `TopbarAccount`
   / `Settings` component tests.
7. **Release** — version, CHANGELOG, What's New + screenshot, coverage,
   ROADMAP.
