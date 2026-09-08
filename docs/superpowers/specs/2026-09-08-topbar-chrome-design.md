# Top bar chrome pass (UI-1 / UI-2 / UI-4 / UI-5) — design

**Status:** approved (brainstorm 2026-09-08)
**Roadmap:** `ROADMAP.md` → Active → "Google-Docs-style top bar & version history (2026-09-08)"
**Ships as:** one user-facing minor release (`1.54.0`).

## Goal

Bring the top-bar action cluster closer to Google Docs' chrome:

- **UI-1** — icon buttons become circular, application-wide.
- **UI-2** — a signed-in GitHub avatar (with a small account menu) as the
  last top-bar item; a person-icon sign-in button when signed out.
- **UI-4** — the mode switcher drops its text label when the collaborator
  can actually switch modes (icon + caret only); keeps the label in the
  single-mode (viewer) case.
- **UI-5** — a lightweight CSS-only hover/focus tooltip (`data-tooltip`)
  replacing the native `title=` on the top-bar buttons.

## Non-goals / deferred

- **UI-3 (Version History redesign)** is **dropped from this pass.**
  `VersionHistory.svelte` already implements everything the roadmap
  listed as a gap: "Today"/short-date labels, a `(current)` marker,
  session grouping, per-group expand/collapse, and author avatars with a
  `+N` overflow. Any remaining polish there is a small fix, not
  spec-worthy. This spec's implementation plan closes UI-3 in the
  roadmap (or files a small-fix note for anything a fresh look against
  Google Docs turns up).
- **A JS-positioned tooltip primitive.** UI-5 is deliberately CSS-only
  (`::after` on `[data-tooltip]`). A tooltip on a button inside a future
  `overflow: hidden` container would clip; upgrading to a
  JS-positioned/portalled tooltip is left to the Accessibility pass
  (already a separate roadmap item), which also owns the real
  `aria-describedby` wiring.
- **`aria-describedby` / role="tooltip" wiring.** The `::after` chip is
  decorative; screen-reader users rely on the existing `aria-label` on
  each button, which is unchanged. Proper ARIA tooltip semantics belong
  to the Accessibility pass.
- **Server changes.** None. The avatar image comes from the public
  `https://github.com/<username>.png` redirect; sign-out reuses the
  existing `POST /api/auth/github/logout`.
- **A new store for account state.** `githubUsername`
  (`client/src/stores/github.ts`, already populated by `gist.ts` from
  `/api/auth/github/me`) is sufficient.
- **Touching top-bar sizes or accent colours.** Per
  `feedback_topbar_sizing_locked`: keep the 40px button box and the
  app's own accent tokens. This pass changes `border-radius` and adds
  one new item; nothing else.
- **Removing `SignedOutIndicator.svelte`.** It stays — it is a narrower,
  contextual "you may have access to this shared workspace but aren't
  signed in" prompt gated on `$identityUnverified`, distinct from the
  general account button.

## Global constraints

- Two `tsconfig.json`s, checked separately (root strict; client relaxed).
  New client code lives under `client/src/`.
- Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`). Component
  tests go in `tests/client/src/components/*.test.ts` (routed to the
  `components` Vitest project — real headless Chromium).
- `npm run format` (Prettier) and `npm run typecheck` must pass.
- A user-facing change bumps the **minor** version and needs all three
  of: `package.json` (+ both `package-lock.json` `"version"` fields),
  a new `## [1.54.0]` CHANGELOG section, and a `whats-new-entries.ts`
  entry **with a real committed screenshot** in
  `client/public/whats-new/`.
- `docs/TEST-COVERAGE.md` gets rows for the new coverage.

---

## UI-1 — circular icon buttons (application-wide)

### Current state

`.icon-btn` (`client/src/styles/_utilities.scss:75`): `border-radius: 6px`,
`32×32`, transparent, `.icon` 18px. Hover → `--border` fill; `.active` →
`--accent-dim` fill + `--accent` colour; `:disabled` → `opacity: 0.4`.

Override sites (found via `grep -rn '\.icon-btn' client/src/styles`):

| Site | File:line | Box | Explicit `border-radius`? |
|---|---|---|---|
| Top-bar action cluster | `_topbar.scss:63` | `40×40` | no (inherits base) |
| `#menuBar .icon-btn` | `_menu.scss:241` | base `32×32` | no |
| `.workspace-row .icon-btn` (share dialog rows) | `_share-workspace.scss:382` | base | no |
| `_share-workspace.scss:452` (`#topbarActionsCol .icon-btn` dark tweak) | — | `40×40` | no |
| `.toolbar-overflow .icon-btn` (the "⋯" overflow menu rows) | `_topbar.scss:203` | not guaranteed square | **yes — `border-radius: 5px`** |
| `_utilities.scss:446`, `:614`, `:738` (mobile / grouped contexts) | — | base | to confirm during implementation |

### Change

- `_utilities.scss:82`: base `border-radius: 6px` → `border-radius: 50%`.
- **Leave `.toolbar-overflow .icon-btn`'s explicit `border-radius: 5px`
  in place.** Those are rows inside a dropdown list, not chrome buttons;
  a circle there is wrong and the row may not be square (→ oval).
- During implementation, open each remaining override site
  (`_utilities.scss:446`, `:614`, `:738`, and any the grep missed) in a
  running build and confirm the button is square and reads correctly as
  a circle. **Any site that renders an oval or reads wrong gets an
  explicit `border-radius` override restoring its prior look**, and is
  listed in the implementation plan + the commit message. The default is
  global; the walkback list is explicit and enumerated, not open-ended.

### Acceptance

- Top-bar comments / version-history / settings / save-status buttons,
  menu-bar icon buttons, sidebar-header icon buttons, and modal-header
  icon buttons render as circles.
- The `.toolbar-overflow` "⋯" menu rows are visually unchanged.
- Hover / `.active` / `:disabled` fills follow the new radius (they use
  `background`, no radius of their own — automatic).
- No layout shift: `border-radius` doesn't affect box size.

### Tests

- A unit assertion on the compiled CSS is brittle; instead a Playwright
  check in the existing local e2e suite: `#versionHistoryBtn` computed
  `border-radius` is a circle (`>= 50%` of its width in px), and a
  `.toolbar-overflow .icon-btn` (open the overflow menu first) is not.

---

## UI-4 — compact mode switcher

### Current state

`client/src/components/ModeSwitcher.svelte` renders, when
`$collabRole && $effectiveMode`:

```
[icon]  [.mode-switcher-label = LABELS[mode]]  [.menu-chevron (only if modesAllowed > 1)]
```

`_topbar.scss:332` `#topbarActionsCol .mode-switcher-btn`: `width: auto`,
`height: 40px`, `gap: 6px`, `padding: 0 12px`, `border-radius: 10px`.
`_topbar.scss:370` hides `.mode-switcher-label` under `max-width: 780px`.

### Change

**`ModeSwitcher.svelte`** — gate the label on the single-mode case:

```svelte
<button ... class="mode-switcher-btn icon-btn" data-tooltip={LABELS[$effectiveMode]} ...>
  <svg class="icon"><use href="#{ICONS[$effectiveMode]}"></use></svg>
  {#if $modesAllowed.length < 2}
    <span class="mode-switcher-label">{LABELS[$effectiveMode]}</span>
  {/if}
  {#if $modesAllowed.length > 1}<svg class="icon menu-chevron">…</svg>{/if}
</button>
```

The dropdown menu items (`.mode-switcher-item`) keep their label +
description unchanged.

**`_topbar.scss:332`** — tighten the multi-mode (now icon+caret) button:
`gap: 4px`, `padding: 0 8px`. `border-radius: 10px` is overridden to
`50%` by the UI-1 base change **only if the button is square** — it
carries a caret so it is `~44px` wide; keep an explicit
`border-radius: 20px` (pill) on `.mode-switcher-btn` so it stays a
rounded pill rather than an oval. Single-mode (has a label) also stays a
pill via the same rule.

The `max-width: 780px` rule at `_topbar.scss:370` stays — still correct
for the single-mode case on mobile.

### Acceptance

- An editor / reviewer (2+ modes): switcher shows icon + caret, no text.
  Hovering shows the mode name (UI-5 tooltip).
- A viewer (1 mode): switcher shows icon + "Viewing", no caret, inert
  (unchanged behaviour).
- Neither renders an oval.
- `tests/e2e/collab/mode-switcher.spec.ts` still passes — its
  `toContainText("Viewing")` assertion is on the viewer (single-mode)
  switcher, which keeps its label.

### Tests

- New component test (`ModeSwitcher.test.ts`): with `modesAllowed`
  length ≥ 2, the button has **no** `.mode-switcher-label`; with length
  1, it has one reading the mode name.

---

## UI-5 — CSS-only hover/focus tooltip

### New file: `client/src/styles/_tooltip.scss`

Registered in `client/src/style.scss` — add `@use "./styles/tooltip";`
to its `@use` list (after `./styles/topbar`).

```scss
[data-tooltip] {
  position: relative;
}
[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--tooltip-bg, #1f2430);
  color: var(--tooltip-fg, #fff);
  font: 500 12px/1.3 var(--sans);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  z-index: 400; // above #topbar's 300
}
@media (prefers-reduced-motion: no-preference) {
  [data-tooltip]::after { transition: opacity 0.12s ease; }
}
[data-tooltip]:hover::after,
[data-tooltip]:focus-visible::after {
  opacity: 1;
}
```

- `--tooltip-bg` / `--tooltip-fg` fall back to literals but are defined
  as tokens in `_variables.scss` (light + dark) so the chip is legible
  in both themes — dark chip on light UI, light chip on dark UI.
- The chip renders **below** the button. `#topbar` is `z-index: 300`,
  `position: relative`, with **no `overflow: hidden`** on it,
  `#topbarActionsCol`, or `.topbar-actions` (verified) — the chip
  escapes over the toolbar row below.

### Markup migration (`client/index.html`)

For `#saveStatusBtn`, `#commentsBtn`, `#versionHistoryBtn`,
`#settingsBtn`, `#sidebarToggleIn`, `#newDocBtn` (and `#suggestionsBtn`):

- Move the human string from `title="…"` to `data-tooltip="…"`.
- **Remove `title=`** (both = a native tooltip *and* the chip).
- **Keep `aria-label` exactly as-is.**

`#shareBtn` keeps its visible "Share" label and its `title` is dropped
without a `data-tooltip` (redundant with the label).

`ModeSwitcher.svelte` and `TopbarAccount.svelte` set `data-tooltip` in
their own markup (see UI-4, UI-2).

### Acceptance

- Hovering or keyboard-focusing a top-bar icon button shows a dark chip
  with its label, below the button, not clipped.
- No native `title` tooltip appears on those buttons.
- `prefers-reduced-motion: reduce` → no fade, chip still appears.
- Screen readers announce the unchanged `aria-label`.

### Tests

- Component/DOM test: after the migration, `#versionHistoryBtn` has a
  `data-tooltip` attribute and no `title`.
- Playwright (local e2e): `page.hover("#versionHistoryBtn")` →
  the `::after` content is visible / the button matches
  `[data-tooltip]`. (Assert on the attribute + a visibility proxy;
  `::after` text isn't directly queryable, so assert
  `getComputedStyle(el, '::after').opacity === '1'` on hover.)

---

## UI-2 — top-bar account button + avatar

### New component: `client/src/components/TopbarAccount.svelte`

**Mount:** a `<div id="topbar-account-mount"></div>` in `client/index.html`
as the **last child** of `.topbar-actions` (after `#settingsBtn`);
`mount(TopbarAccount, { target: document.getElementById("topbar-account-mount")! })`
in `client/src/main.ts`.

**State:** `import { githubUsername } from "../stores/github"`. No new
store, no fetch of its own — `gist.ts` already calls
`/api/auth/github/me` on load and on auth changes and sets the store.

**Signed in** (`$githubUsername` is a non-empty string):

```svelte
<div class="topbar-account dropdown">
  <button
    class="topbar-account-btn icon-btn"
    data-tooltip={$githubUsername}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={toggle}
  >
    {#if !imgFailed}
      <img
        src={`https://github.com/${$githubUsername}.png?size=80`}
        alt=""
        class="topbar-account-avatar"
        onerror={() => (imgFailed = true)}
      />
    {:else}
      <svg class="icon"><use href="#icon-user"></use></svg>
    {/if}
  </button>
  {#if open}
    <div class="dropdown-menu topbar-account-menu" role="menu">
      <div class="menu-section-label">{$githubUsername}</div>
      <button type="button" role="menuitem" class="dropdown-item" onclick={signOut}>
        <svg class="icon"><use href="#icon-log-out"></use></svg> Sign out
      </button>
    </div>
  {/if}
</div>
```

- `.topbar-account-avatar`: `width: 100%; height: 100%; object-fit: cover;
  border-radius: 50%; display: block;` — fills the 40px circle, no
  padding.
- `imgFailed` (`$state(false)`): set by `onerror` (deleted account,
  offline, rate-limited) → fall back to the `#icon-user` glyph.
- `signOut()`: `await fetch("/api/auth/github/logout", { method: "POST" });
  location.reload();` — identical to `Settings.svelte:39`.
- Open/close: `toggle()` calls `window.MDE.closeAllDropdowns?.()` then
  flips `open`; an `onMount` document-click listener closes on
  outside-click; Escape closes. Same pattern as `ModeSwitcher.svelte`.
- Menu is right-aligned (`right: 0`) like `#shareDropdownMenu`.

**Signed out** (`$githubUsername` is null):

```svelte
<button
  class="topbar-account-btn icon-btn"
  data-tooltip="Sign in"
  aria-label="Sign in with GitHub"
  onclick={() => window.MDE.openGithubSignInPopup()}
>
  <svg class="icon"><use href="#icon-user"></use></svg>
</button>
```

The sprite sheet (`client/index.html`) has `#icon-users` (two people)
and `#icon-log-out` but **no `#icon-user`** — add an `#icon-user`
`<symbol>` (Feather `user`: a head circle + shoulders arc,
`viewBox="0 0 24 24"`) next to `#icon-users`. Used by both the
signed-out button and the avatar-error fallback.

### Relationship to existing affordances

- `SignedOutIndicator.svelte` (sidebar footer, gated on
  `$identityUnverified`): **unchanged**. Contextual, narrower message.
  Both can show at once.
- `Settings.svelte`'s account section (Connect / Disconnect):
  **unchanged**. The new menu's "Sign out" is a shortcut to the same
  `logout` endpoint.

### Acceptance

- Signed in: a circular avatar as the last top-bar item; hover/focus →
  username chip; click → menu with the username + "Sign out"; "Sign out"
  hits `logout` and reloads.
- Avatar image 404/error → person glyph, no broken-image icon.
- Signed out: a person-outline icon button; hover → "Sign in"; click →
  the GitHub sign-in popup.
- The button is a 40px circle consistent with UI-1.

### Tests (`tests/client/src/components/TopbarAccount.test.ts`)

- `githubUsername.set("octocat")` → renders `<img>` with
  `src` containing `github.com/octocat.png`; clicking the button then
  "Sign out" calls `fetch` with `/api/auth/github/logout` +
  `method: "POST"` (stub `fetch` + `location.reload`).
- Dispatching the `<img>` `error` event → the `#icon-user` `<use>` is
  present, `<img>` gone.
- `githubUsername.set(null)` → the person-icon button; clicking it calls
  `window.MDE.openGithubSignInPopup`.

---

## Release

- `package.json` + `package-lock.json` (both `"version"` fields) →
  `1.54.0`.
- `CHANGELOG.md`: `## [1.54.0] - <date>` with `### Changed` (circular
  buttons, compact mode switcher, hover tooltips) and `### Added` (top-bar
  account menu / avatar).
- `client/src/whats-new-entries.ts`: a `1.54.0` entry
  (`screenshot: "/whats-new/topbar-chrome.png"`) + a real screenshot
  committed to `client/public/whats-new/topbar-chrome.png` in the same
  change (captured via a Playwright script against a local build — the
  signed-in top bar with the avatar + a tooltip visible).
- `ROADMAP.md`: mark UI-1 / UI-2 / UI-4 / UI-5 shipped `v1.54.0`; note
  UI-3 closed as already-implemented (or a small-fix follow-up if the
  fresh look found a real gap); copy this spec's Non-goals into the
  deferred list.
- `docs/TEST-COVERAGE.md`: rows for the new component + e2e coverage.

## Implementation order (one commit each, TDD)

1. **UI-1** — base `border-radius` + override walkback + the e2e circle
   assertion.
2. **UI-5** — `_tooltip.scss` + tokens + `index.html` `title` → `data-tooltip`
   migration + tests. (Before UI-4/UI-2 so they can use `data-tooltip`.)
3. **UI-4** — `ModeSwitcher.svelte` label gating + CSS + component test.
4. **UI-2** — `TopbarAccount.svelte` + mount + `#icon-user` check + tests.
5. **Release** — version, CHANGELOG, What's New entry + screenshot,
   ROADMAP, TEST-COVERAGE.
