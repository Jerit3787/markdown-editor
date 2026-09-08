# Top-bar chrome v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the mode-switcher dropdown layout and its left-pointing mobile caret, give the mode switcher an outlined-pill look, shrink the top-bar avatar to a 32px image, and move Settings from its own top-bar button into a redesigned account dropdown.

**Architecture:** All CSS/markup + one tiny new store. Two bugs are unscoped shared-class collisions (`.dropdown-item` `display:block` shadowing `display:flex`; `.menu-chevron` mobile `rotate(90deg)` leaking onto the mode switcher) — fixed with id-scoped rules and a class rename, not by re-basing the shared rules. Settings gets a `settingsModalOpen` writable store so `TopbarAccount` can open it after `#settingsBtn` is removed.

**Tech Stack:** TypeScript, Svelte 5 runes, SCSS (`@use` modules via `client/src/style.scss`), Vitest (`unit` jsdom + `components` headless-Chromium projects), Playwright (`local` project, client-only vite dev on :5275).

**Spec:** `docs/superpowers/specs/2026-09-09-topbar-chrome-v2-design.md`

## Global Constraints

- Two `tsconfig.json`s checked separately — new client code under `client/src/`.
- Svelte 5 runes only. Component test files → `tests/client/src/components/*.test.ts` (routes to the `components` Vitest project — real headless Chromium).
- `npm run format` (Prettier) + `npm run typecheck` must pass before every commit.
- Dark theme is the `[data-theme="dark"]` attribute selector (not a media query). `--border` is already themed; no new tokens expected.
- Keep top-bar button sizes and accent tokens unchanged except the two named here: avatar `padding: 4px`; mode-switcher `border: 1px solid var(--border)` (`feedback_topbar_sizing_locked`).
- User-facing → **minor** bump to `1.56.0`: `package.json` + **both** `"version"` fields in `package-lock.json` (hand-edit); `## [1.56.0] - <today>` CHANGELOG section (`### Fixed` + `### Changed`); one `client/src/whats-new-entries.ts` entry **with a real committed screenshot** at `client/public/whats-new/topbar-chrome-v2.png` (`whats-new-entries.test.ts` fails if it's missing); `category` ∈ `"Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation"`.
- `docs/TEST-COVERAGE.md` updated.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `client/src/styles/_topbar.scss` | mode-switcher menu item flex; caret class rename; button outline; avatar padding; account header styles | 1,2,3,4,6 |
| `client/src/styles/_menu.scss` | scope `.menu-chevron` rules to `#menuBar` | 2 |
| `client/src/styles/_utilities.scss` | one NOTE comment on the shadowing rule | 1 |
| `client/src/components/ModeSwitcher.svelte` | caret class `menu-chevron` → `mode-switcher-caret` | 2 |
| `client/src/stores/settingsModal.ts` (new) | `settingsModalOpen` writable | 5 |
| `client/src/components/Settings.svelte` | drive `hidden` off `settingsModalOpen`; drop the `#settingsBtn` listener | 5 |
| `client/index.html` | remove `#settingsBtn` | 5 |
| `client/src/components/TopbarAccount.svelte` | one shared menu-toggle button; Settings + redesigned header in both branches | 6 |
| `tests/client/src/components/ModeSwitcher.test.ts` | flex layout, caret class, button border | 1,2,3 |
| `tests/e2e/local/support/fixtures.ts` | `openSettings(page)` helper | 5 |
| `tests/e2e/local/keybindings.spec.ts`, `preview-rendering.spec.ts` | open Settings via the account menu | 5 |
| `tests/e2e/local/topbar-chrome.spec.ts` | drop `#settingsBtn` radius check; update the signed-out account-button assertions | 3,5,6 |
| `tests/client/src/topbar-tooltip.test.ts` | drop `"settingsBtn"` from the id list | 5 |
| `tests/client/src/components/TopbarAccount.test.ts` | rewrite for the menu-toggle + Settings + header | 6 |
| `tests/client/src/components/Settings.test.ts` (new) | opens off `settingsModalOpen` | 5 |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/topbar-chrome-v2.png`, `tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs` (new), `docs/TEST-COVERAGE.md`, `ROADMAP.md` | release | 7 |

---

## Task 1: mode-switcher dropdown layout

**Files:**
- Modify: `client/src/styles/_topbar.scss` (the `.mode-switcher-menu .mode-switcher-item` rule, ~line 361)
- Modify: `client/src/styles/_utilities.scss` (NOTE comment above the `.dropdown-menu button:not(...)` rule, ~line 183)
- Test: `tests/client/src/components/ModeSwitcher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

**Context:**
- `ModeSwitcher.svelte` menu item markup:
  ```svelte
  <button class="mode-switcher-item dropdown-item" ...>
    <svg class="icon"><use href="#{ICONS[m]}"></use></svg>
    <span class="mode-switcher-item-text">
      <span class="mode-switcher-item-label">{LABELS[m]}</span>
      <span class="mode-switcher-desc">{DESCRIPTIONS[m]}</span>
    </span>
  </button>
  ```
- `_utilities.scss` ~167 `.dropdown-menu button.dropdown-item { display: flex; align-items: center; gap: 8px; }` (0,2,1) is shadowed by ~184 `.dropdown-menu button.dropdown-item, .dropdown-menu button:not(.primary-btn):not(.secondary-btn) { display: block; … }` (0,3,1 via the `:not()` selector). Net: `.dropdown-item` is `display: block`.
- `_topbar.scss` ~361 currently: `.mode-switcher-menu .mode-switcher-item { align-items: flex-start; }` — inert (item isn't a flex box).
- `#mode-switcher-mount` is inside `#topbarActionsCol`, so an id-scoped selector reaches the menu.
- `ModeSwitcher.test.ts` renders with `enterCollabRoom("r1", "editor", true)` for 3 modes; the menu opens on `screen.getByRole("button", { name: /Editing/i }).click()`.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/components/ModeSwitcher.test.ts`, add:

```ts
test("v2: dropdown items lay the icon out beside the two-line text, not above it", async () => {
  enterCollabRoom("r1", "editor", true);
  const screen = await render(ModeSwitcher);
  await screen.getByRole("button", { name: /Editing/i }).click();

  const item = screen.container.querySelector(".mode-switcher-item") as HTMLElement;
  expect(getComputedStyle(item).display).toBe("flex");

  const icon = item.querySelector(".icon") as HTMLElement;
  const text = item.querySelector(".mode-switcher-item-text") as HTMLElement;
  // Same row: the icon's top is within 6px of the text block's top, not
  // a full line above it.
  expect(Math.abs(icon.getBoundingClientRect().top - text.getBoundingClientRect().top)).toBeLessThan(6);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts -t "v2: dropdown items"`
Expected: FAIL — `getComputedStyle(item).display` is `"block"`.

- [ ] **Step 3: Fix the CSS**

In `client/src/styles/_topbar.scss`, replace:

```scss
.mode-switcher-menu .mode-switcher-item {
  align-items: flex-start;
}
```
with:
```scss
/* .dropdown-item is really display:block app-wide (a _utilities.scss rule
   shadows its own display:flex — see the NOTE there). The mode rows need
   a real flex box so the icon sits beside the two-line text; scope it by
   #id so it can't lose the specificity race. */
#topbarActionsCol .mode-switcher-menu .mode-switcher-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
#topbarActionsCol .mode-switcher-menu .mode-switcher-item .icon {
  flex-shrink: 0;
  margin-top: 1px;
}
```

In `client/src/styles/_utilities.scss`, immediately above the
`.dropdown-menu button.dropdown-item,` rule (~line 183), add:

```scss
/* NOTE: the `display: block` below also matches .dropdown-item and
   shadows its own `display: flex` a few lines up — harmless for plain
   <svg> Text rows, but any .dropdown-item with a block/flex child needs
   its own scoped override (see the mode switcher in _topbar.scss).
   A broad re-base is deferred — 2026-09-09 topbar-chrome-v2 spec. */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Visual check**

`npm run build && npm run dev:client`, open `:5275`, in devtools console:
`(await import("/src/stores/collabMode.ts")).enterCollabRoom("x","editor",true)` — then click the mode switcher. Each row: `[icon]  Label` on line 1, grey description under the label.

- [ ] **Step 6: Commit**

```bash
npm run format
git add client/src/styles/_topbar.scss client/src/styles/_utilities.scss tests/client/src/components/ModeSwitcher.test.ts
git commit -m "$(cat <<'EOF'
fix(ui): mode-switcher dropdown lays the icon beside the text, not above it

.dropdown-item is really display:block app-wide (a _utilities.scss rule
shadows its own display:flex). The mode rows have a two-line text column
child that then dropped below the icon. Restore a real flex box with an
id-scoped rule; NOTE the shared-rule collision for a later cleanup.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: mobile caret direction

**Files:**
- Modify: `client/src/styles/_menu.scss` (the `.menu-chevron` base rule ~53, and the two `@media (max-width: 780px)` rules ~219-232)
- Modify: `client/src/components/ModeSwitcher.svelte` (caret class)
- Modify: `client/src/styles/_topbar.scss` (`.menu-chevron` → `.mode-switcher-caret` in the mode-switcher-btn rule ~348)
- Test: `tests/client/src/components/ModeSwitcher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the mode switcher's caret element now has class `mode-switcher-caret` (was `menu-chevron`).

**Context:**
- `_menu.scss` ~53:
  ```scss
  .menu-chevron { margin-left: auto; width: 12px; height: 12px; opacity: 0.55; }
  ```
- `_menu.scss` ~219:
  ```scss
  @media (max-width: 780px) {
    .menu-chevron { transform: rotate(90deg); }
  }
  @media (max-width: 780px) {
    .menu-submenu-trigger.active .menu-chevron { transform: rotate(-90deg); }
  }
  ```
  All three are menu-bar-submenu behaviour but the selector is unscoped.
- `ModeSwitcher.svelte` ~51: `<svg class="icon menu-chevron"><use href="#icon-chevron-down"></use></svg>`.
- `_topbar.scss` ~348: `#topbarActionsCol .mode-switcher-btn .menu-chevron { width: 14px; height: 14px; opacity: 0.7; }` — overrides `width`/`opacity` but NOT `margin-left: auto` or the mobile `transform`.
- File/Edit/Help submenu carets are `.menu-submenu-trigger .menu-chevron` inside `#menuBar` — scoping to `#menuBar` keeps them working. `menu-shell.spec.ts` and `mobile-menu-overflow.spec.ts` exercise those.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/components/ModeSwitcher.test.ts`, add:

```ts
test("v2: the caret uses its own class, not the menu-bar's .menu-chevron", async () => {
  enterCollabRoom("r1", "editor", true);
  const screen = await render(ModeSwitcher);
  const btn = screen.getByRole("button", { name: /Editing/i });
  const caret = (await btn.element()).querySelector("svg.mode-switcher-caret");
  expect(caret).not.toBeNull();
  expect((await btn.element()).querySelector("svg.menu-chevron")).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts -t "v2: the caret uses its own class"`
Expected: FAIL — the caret still has class `menu-chevron`.

- [ ] **Step 3: Rename the caret class**

In `client/src/components/ModeSwitcher.svelte`, line ~51:

```svelte
{#if $modesAllowed.length > 1}<svg class="icon mode-switcher-caret"><use href="#icon-chevron-down"></use></svg>{/if}
```

In `client/src/styles/_topbar.scss`, in the `#topbarActionsCol .mode-switcher-btn .menu-chevron` rule (~line 348), rename the selector and add the properties the base `.menu-chevron` used to give it:

```scss
#topbarActionsCol .mode-switcher-btn .mode-switcher-caret {
  width: 14px;
  height: 14px;
  opacity: 0.7;
  flex-shrink: 0;
}
```

- [ ] **Step 4: Scope the menu-bar chevron rules**

In `client/src/styles/_menu.scss`:

Base rule (~53) →
```scss
#menuBar .menu-chevron {
  margin-left: auto;
  width: 12px;
  height: 12px;
  opacity: 0.55;
}
```

Both `@media (max-width: 780px)` rules (~219-232) →
```scss
@media (max-width: 780px) {
  #menuBar .menu-chevron {
    transform: rotate(90deg);
  }
}
@media (max-width: 780px) {
  #menuBar .menu-submenu-trigger.active .menu-chevron {
    transform: rotate(-90deg);
  }
}
```

- [ ] **Step 5: Run the component tests**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the menu e2e to confirm no regression**

Run: `npx playwright test --project=local tests/e2e/local/menu-shell.spec.ts tests/e2e/local/menu-format-insert.spec.ts`
Expected: PASS.

- [ ] **Step 7: Mobile visual check**

`npm run dev:client`, open `:5275`, devtools → responsive mode 375px wide. Enter a collab room (console, as Task 1). The mode-switcher caret points **down**. Open the File menu — its submenu carets (Open, Export) point **down** when collapsed.

- [ ] **Step 8: Commit**

```bash
npm run format
git add client/src/styles/_menu.scss client/src/styles/_topbar.scss client/src/components/ModeSwitcher.svelte tests/client/src/components/ModeSwitcher.test.ts
git commit -m "$(cat <<'EOF'
fix(ui): mode-switcher caret points down on mobile, not left

_menu.scss rotated every .menu-chevron 90° on mobile — meant only for
File-menu submenu triggers, but the class was unscoped and the mode
switcher reused it. Scope those rules to #menuBar and rename the mode
switcher's caret to .mode-switcher-caret so it can't collide again.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: mode-switcher button outline

**Files:**
- Modify: `client/src/styles/_topbar.scss` (`#topbarActionsCol .mode-switcher-btn` ~332)
- Modify: `tests/client/src/components/ModeSwitcher.test.ts`
- Modify: `tests/e2e/local/topbar-chrome.spec.ts` (the `#settingsBtn` radius line — see Task 5; here just note it)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

**Context:**
- Current rule (`_topbar.scss` ~332): `width: auto; height: 40px; display: inline-flex; align-items: center; gap: 4px; padding: 0 10px; border-radius: 20px;` — no border.
- `.icon-btn` base: `border: none; background: transparent`. Hover: `.icon-btn:hover { background: var(--border) }`.
- The button also carries `aria-expanded={open}` from `ModeSwitcher.svelte`.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/components/ModeSwitcher.test.ts`, add:

```ts
test("v2: the switcher button is an outlined pill", async () => {
  enterCollabRoom("r1", "editor", true);
  const screen = await render(ModeSwitcher);
  const btn = await screen.getByRole("button", { name: /Editing/i }).element();
  const cs = getComputedStyle(btn);
  expect(cs.borderStyle).toBe("solid");
  expect(parseFloat(cs.borderTopWidth)).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts -t "v2: the switcher button is an outlined pill"`
Expected: FAIL — `borderStyle` is `"none"`.

- [ ] **Step 3: Add the border + states**

In `client/src/styles/_topbar.scss`, `#topbarActionsCol .mode-switcher-btn` rule — add `border: 1px solid var(--border);` (keep everything else), then add after it:

```scss
#topbarActionsCol .mode-switcher-btn:hover {
  background: var(--bg-alt);
  border-color: var(--text-dim);
}
#topbarActionsCol .mode-switcher-btn[aria-expanded="true"] {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}
```

- [ ] **Step 4: Run the component tests**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Visual check (light + dark)**

`npm run dev:client`, enter a collab room, confirm the switcher is a bordered pill; hover and open (click) states are distinct. Toggle `data-theme="dark"` on `<html>` in devtools — border still visible.

- [ ] **Step 6: Commit**

```bash
npm run format
git add client/src/styles/_topbar.scss tests/client/src/components/ModeSwitcher.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): mode switcher is an outlined pill (Google-Docs style)

border: 1px solid var(--border) on #topbarActionsCol .mode-switcher-btn,
plus explicit hover / [aria-expanded=true] states so the button reads as
a control, not a bare icon.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: avatar sizing

**Files:**
- Modify: `client/src/styles/_topbar.scss` (`#topbarActionsCol .topbar-account-btn` + `.topbar-account-avatar`, ~385-400)
- Test: `tests/client/src/components/TopbarAccount.test.ts` (add one assertion; the full rewrite is Task 6)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

**Context:**
- Current (`_topbar.scss` ~387):
  ```scss
  #topbarActionsCol .topbar-account-btn { width: 40px; height: 40px; padding: 0; overflow: hidden; }
  #topbarActionsCol .topbar-account-avatar { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 50%; }
  ```
  The `<img>` fills the whole 40px button.
- `TopbarAccount.test.ts` "signed in" test already renders `img.topbar-account-avatar` for `githubUsername = "octocat"`.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/components/TopbarAccount.test.ts`, add:

```ts
test("v2: the avatar image is inset (32px inside the 40px button), not full-bleed", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  const btn = screen.container.querySelector(".topbar-account-btn") as HTMLElement;
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLElement;
  expect(parseFloat(getComputedStyle(btn).paddingLeft)).toBeGreaterThanOrEqual(3);
  expect(img.getBoundingClientRect().width).toBeLessThanOrEqual(34);
});
```

Requires a real layout — this runs in the `components` (Chromium) project, so `getBoundingClientRect` is real. Mount into `document.body` is automatic via `render`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/TopbarAccount.test.ts -t "v2: the avatar image is inset"`
Expected: FAIL — `paddingLeft` is `0`, avatar width ~40.

- [ ] **Step 3: Fix the CSS**

In `client/src/styles/_topbar.scss`:

```scss
#topbarActionsCol .topbar-account-btn {
  width: 40px;
  height: 40px;
  padding: 4px;
}
#topbarActionsCol .topbar-account-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 50%;
}
```

(Drop `overflow: hidden` — the avatar is inset and round.)

- [ ] **Step 4: Run the test**

Run: `npx vitest run --project=components tests/client/src/components/TopbarAccount.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add client/src/styles/_topbar.scss tests/client/src/components/TopbarAccount.test.ts
git commit -m "$(cat <<'EOF'
fix(ui): top-bar avatar is a 32px image in a 40px button (was full-bleed)

padding: 4px on the account button — the avatar now matches the visual
weight of the other 18px-glyph top-bar icons, like Google's.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: move Settings into the account menu (plumbing)

**Files:**
- Create: `client/src/stores/settingsModal.ts`
- Modify: `client/src/components/Settings.svelte`
- Modify: `client/index.html` (remove `#settingsBtn`)
- Modify: `tests/e2e/local/support/fixtures.ts` (add `openSettings`)
- Modify: `tests/e2e/local/keybindings.spec.ts`, `tests/e2e/local/preview-rendering.spec.ts`
- Modify: `tests/e2e/local/topbar-chrome.spec.ts` (drop the `#settingsBtn` radius assertion)
- Modify: `tests/client/src/topbar-tooltip.test.ts` (drop `"settingsBtn"`)
- Create: `tests/client/src/components/Settings.test.ts`

**Interfaces:**
- Produces: `settingsModalOpen: Writable<boolean>` from `client/src/stores/settingsModal.ts` (default `false`). Task 6's `TopbarAccount` sets it `true`.
- Produces: `openSettings(page): Promise<void>` from `tests/e2e/local/support/fixtures.ts` — clicks `#topbar-account-mount .topbar-account-btn` then the `Settings` menuitem.

**Context:**
- `Settings.svelte` today: `let hidden = $state(true);` `function open() { hidden = false; }` `function close() { hidden = true; }`; `onMount` does `document.getElementById("settingsBtn")?.addEventListener("click", open);`; the Escape handler is `if (e.key === "Escape" && !hidden) close();`. Template is `{#if !hidden}<Modal … onClose={close}>…`.
- `client/index.html` ~400: `<button id="settingsBtn" class="icon-btn" data-tooltip="Settings" aria-label="Settings"><svg class="icon"><use href="#icon-settings"></use></svg></button>` — sits inside `.topbar-actions`, right before `<div id="topbar-account-mount"></div>`.
- Per-modal-open-store pattern already in the repo: `stores/shortcutsModal.ts`, `stores/githubSignInModal.ts`, `stores/linkModal.ts`, etc.
- `keybindings.spec.ts` uses `page.click("#settingsBtn")` in 5 tests (lines ~14, 25, 32, 41, 45). `preview-rendering.spec.ts` line ~71. The `local` e2e suite is always signed-out (no `/api` backend) — so the **signed-out** account menu MUST carry `Settings` (Task 6 handles the menu; this task's helper depends on it, so the helper's own first use is in Task 6's e2e — but wire the spec files now and let Task 6's menu make them pass; run them at the end of Task 6).
- `topbar-tooltip.test.ts` line 9: `const ids = ["commentsBtn", "versionHistoryBtn", "settingsBtn", "newDocBtn"];`
- `topbar-chrome.spec.ts` lines 12-13: `const settings = await radius("#settingsBtn"); expect(settings.br)...`.

- [ ] **Step 1: Create the store**

`client/src/stores/settingsModal.ts`:

```ts
import { writable } from "svelte/store";

// Opened from the top-bar account menu (TopbarAccount.svelte). Its own
// tiny store so that menu can reach it without importing the component —
// same pattern as shortcutsModal / githubSignInModal / linkModal.
export const settingsModalOpen = writable(false);
```

- [ ] **Step 2: Write the failing Settings component test**

`tests/client/src/components/Settings.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import Settings from "../../../../client/src/components/Settings.svelte";
import { settingsModalOpen } from "../../../../client/src/stores/settingsModal";

beforeEach(() => {
  settingsModalOpen.set(false);
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  localStorage.clear();
});

test("the modal is closed until settingsModalOpen goes true, and closes again when it goes false", async () => {
  const screen = await render(Settings);
  expect(screen.container.textContent).not.toContain("Appearance");

  settingsModalOpen.set(true);
  await expect.poll(() => screen.container.textContent).toContain("Appearance");

  settingsModalOpen.set(false);
  await expect.poll(() => screen.container.textContent?.includes("Appearance")).toBe(false);
});

test("closing the modal (× / onClose) sets settingsModalOpen false", async () => {
  settingsModalOpen.set(true);
  const screen = await render(Settings);
  await expect.poll(() => screen.container.textContent).toContain("Appearance");
  // Modal.svelte renders a close control with aria-label "Close"
  await screen.getByRole("button", { name: /close/i }).click();
  await expect.poll(() => screen.container.textContent?.includes("Appearance")).toBe(false);
});
```

(If `Modal.svelte`'s close control isn't named "Close", check `client/src/components/Modal.svelte` and match its actual `aria-label`.)

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/Settings.test.ts`
Expected: FAIL — `Settings.svelte` doesn't import `settingsModalOpen` yet; the modal opens off internal `hidden` state only.

- [ ] **Step 4: Rewire `Settings.svelte`**

In the `<script>`:
- Add `import { settingsModalOpen } from "../stores/settingsModal";`
- Replace `let hidden = $state(true);` with `let hidden = $derived(!$settingsModalOpen);`
- Replace `function open() { hidden = false; }` — delete it.
- `function close() { hidden = true; }` → `function close() { settingsModalOpen.set(false); }`
- In `onMount`, delete the line `document.getElementById("settingsBtn")?.addEventListener("click", open);`
- The Escape handler stays as-is (`if (e.key === "Escape" && !hidden) close();`).

The template `{#if !hidden}` and `onClose={close}` are unchanged.

- [ ] **Step 5: Run the Settings test**

Run: `npx vitest run --project=components tests/client/src/components/Settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Remove `#settingsBtn` from `client/index.html`**

Delete the whole `<button id="settingsBtn" …>…</button>` element (3 lines) from `.topbar-actions`.

- [ ] **Step 7: Add the `openSettings` e2e helper**

In `tests/e2e/local/support/fixtures.ts`, after the `export const test = …` block, add:

```ts
// Settings moved into the top-bar account menu (v1.56.0). The local
// suite is always signed-out; its account menu carries "Settings".
export async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.click("#topbar-account-mount .topbar-account-btn");
  await page.click('.topbar-account-menu [role="menuitem"]:has-text("Settings")');
}
```

- [ ] **Step 8: Update `keybindings.spec.ts` + `preview-rendering.spec.ts`**

`keybindings.spec.ts` — change the import line to also pull `openSettings`:
```ts
import { test, expect, openSettings } from "./support/fixtures";
```
Replace every `await page.click("#settingsBtn");` with `await openSettings(page);` (5 occurrences).

`preview-rendering.spec.ts` — check its import line (it may already be `from "./support/..."`); add `openSettings` to it (or `import { openSettings } from "./support/fixtures";` if it imports `test`/`expect` from elsewhere). Replace the one `await page.click("#settingsBtn");` (line ~71) with `await openSettings(page);`.

- [ ] **Step 9: Update the two client tests**

`tests/client/src/topbar-tooltip.test.ts` line 9 →
```ts
const ids = ["commentsBtn", "versionHistoryBtn", "newDocBtn"];
```

`tests/e2e/local/topbar-chrome.spec.ts` — delete lines 12-13:
```ts
const settings = await radius("#settingsBtn");
expect(settings.br).toBeGreaterThanOrEqual(settings.w * 0.4);
```

- [ ] **Step 10: Run unit + typecheck (e2e that needs the menu waits for Task 6)**

```bash
npm test
npm run typecheck
```
Expected: PASS. (`keybindings.spec.ts` / `preview-rendering.spec.ts` / the account e2e will only pass once Task 6 adds the Settings menuitem — run them at the end of Task 6.)

- [ ] **Step 11: Commit**

```bash
npm run format
git add client/src/stores/settingsModal.ts client/src/components/Settings.svelte client/index.html tests/e2e/local/support/fixtures.ts tests/e2e/local/keybindings.spec.ts tests/e2e/local/preview-rendering.spec.ts tests/e2e/local/topbar-chrome.spec.ts tests/client/src/topbar-tooltip.test.ts tests/client/src/components/Settings.test.ts
git commit -m "$(cat <<'EOF'
refactor(settings): open the Settings modal via a settingsModalOpen store

Removes the #settingsBtn top-bar button and its click-listener wiring;
Settings.svelte now opens off a settingsModalOpen writable (the repo's
per-modal-store pattern). The account menu becomes its entry point
(next commit). e2e opens Settings via a new openSettings() helper.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: account dropdown redesign

**Files:**
- Modify: `client/src/components/TopbarAccount.svelte` (rewrite the template + script)
- Modify: `client/src/styles/_topbar.scss` (account header styles; drop the old `.topbar-account-menu .menu-section-label` rule)
- Modify: `tests/client/src/components/TopbarAccount.test.ts` (rewrite)
- Modify: `tests/e2e/local/topbar-chrome.spec.ts` (update the signed-out account-button test)

**Interfaces:**
- Consumes: `settingsModalOpen` from `../stores/settingsModal` (Task 5); `githubUsername` from `../stores/github`; `window.MDE.openGithubSignInPopup()` / `closeAllDropdowns()`.
- Produces: the DOM the `openSettings` helper (Task 5) targets — `#topbar-account-mount .topbar-account-btn` toggles `.topbar-account-menu` which contains `[role="menuitem"]` buttons including one with text "Settings".

**Context:**
- `.dropdown-divider` class already exists (`#shareDropdownMenu` uses it).
- Sprite ids available: `#icon-user`, `#icon-settings`, `#icon-log-out`, `#icon-github`.
- Current signed-out button calls `signIn` directly; it must become a menu toggle.
- `.dropdown-menu.topbar-account-menu { display: block }` rule (from v1.54.0) stays — keep it.

- [ ] **Step 1: Rewrite the failing test**

Replace the body of `tests/client/src/components/TopbarAccount.test.ts` with:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import TopbarAccount from "../../../../client/src/components/TopbarAccount.svelte";
import { githubUsername } from "../../../../client/src/stores/github";
import { settingsModalOpen } from "../../../../client/src/stores/settingsModal";

beforeEach(() => {
  githubUsername.set(null);
  settingsModalOpen.set(false);
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

test("v2: the avatar image is inset (32px inside the 40px button), not full-bleed", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  const btn = screen.container.querySelector(".topbar-account-btn") as HTMLElement;
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLElement;
  expect(parseFloat(getComputedStyle(btn).paddingLeft)).toBeGreaterThanOrEqual(3);
  expect(img.getBoundingClientRect().width).toBeLessThanOrEqual(34);
});

test("signed in: the button opens a menu with a header, Settings, and Sign out", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: "octocat" }).click();

  expect(screen.container.querySelector(".topbar-account-header-name")?.textContent).toContain("octocat");
  await expect.element(screen.getByRole("menuitem", { name: /settings/i })).toBeVisible();
  await expect.element(screen.getByRole("menuitem", { name: /sign out/i })).toBeVisible();
});

test("signed in: Settings item sets settingsModalOpen true", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: "octocat" }).click();
  await screen.getByRole("menuitem", { name: /settings/i }).click();
  const { get } = await import("svelte/store");
  expect(get(settingsModalOpen)).toBe(true);
});

test("signed in: Sign out POSTs to logout", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: "octocat" }).click();
  await screen.getByRole("menuitem", { name: /sign out/i }).click();
  expect(fetch).toHaveBeenCalledWith("/api/auth/github/logout", { method: "POST" });
});

test("signed out: the button opens a menu with Sign in with GitHub + Settings", async () => {
  const openSpy = vi.fn();
  window.MDE = new Proxy(
    { openGithubSignInPopup: openSpy },
    { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? vi.fn() },
  ) as unknown as typeof window.MDE;
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: /account/i }).click();

  await screen.getByRole("menuitem", { name: /sign in with github/i }).click();
  expect(openSpy).toHaveBeenCalled();
});

test("signed out: Settings item is present and sets the store", async () => {
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: /account/i }).click();
  await screen.getByRole("menuitem", { name: /settings/i }).click();
  const { get } = await import("svelte/store");
  expect(get(settingsModalOpen)).toBe(true);
});

test("signed in: an avatar load error falls back to the person glyph in the button", async () => {
  githubUsername.set("ghost");
  const screen = await render(TopbarAccount);
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLImageElement;
  img.dispatchEvent(new Event("error"));
  await expect.poll(() => screen.container.querySelector("img.topbar-account-avatar")).toBeNull();
  expect(screen.container.querySelector('.topbar-account-btn use[href="#icon-user"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/TopbarAccount.test.ts`
Expected: FAIL — no `.topbar-account-header-name`, signed-out button isn't named "account", no menu in the signed-out branch.

- [ ] **Step 3: Rewrite `TopbarAccount.svelte`**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { githubUsername } from "../stores/github";
  import { settingsModalOpen } from "../stores/settingsModal";

  let open = $state(false);
  let imgFailed = $state(false);

  function toggle() {
    window.MDE.closeAllDropdowns?.();
    open = !open;
  }
  function signIn() {
    open = false;
    window.MDE.openGithubSignInPopup();
  }
  function openSettings() {
    open = false;
    settingsModalOpen.set(true);
  }
  async function signOut() {
    open = false;
    await fetch("/api/auth/github/logout", { method: "POST" });
    location.reload();
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (open && !(e.target as HTMLElement).closest(".topbar-account")) open = false;
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) open = false;
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });

  $effect(() => {
    $githubUsername;
    imgFailed = false;
  });
</script>

<div class="topbar-account dropdown">
  <button
    type="button"
    class="topbar-account-btn icon-btn tooltip-end"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={$githubUsername ? $githubUsername : "Account"}
    data-tooltip={$githubUsername ? $githubUsername : "Account"}
  >
    {#if $githubUsername && !imgFailed}
      <img
        class="topbar-account-avatar"
        src={`https://github.com/${$githubUsername}.png?size=80`}
        alt=""
        onerror={() => (imgFailed = true)}
      />
    {:else}
      <svg class="icon"><use href="#icon-user"></use></svg>
    {/if}
  </button>

  {#if open}
    <div class="dropdown-menu topbar-account-menu" role="menu" style="right: 0; min-width: 240px">
      <div class="topbar-account-header">
        <span class="topbar-account-header-avatar">
          {#if $githubUsername && !imgFailed}
            <img src={`https://github.com/${$githubUsername}.png?size=64`} alt="" onerror={() => (imgFailed = true)} />
          {:else}
            <svg class="icon"><use href="#icon-user"></use></svg>
          {/if}
        </span>
        <span class="topbar-account-header-text">
          <span class="topbar-account-header-name">{$githubUsername ?? "Not signed in"}</span>
          <span class="topbar-account-header-sub">
            {$githubUsername ? "Signed in via GitHub" : "Sign in to share & publish"}
          </span>
        </span>
      </div>
      <div class="dropdown-divider"></div>
      {#if !$githubUsername}
        <button type="button" role="menuitem" class="dropdown-item" onclick={signIn}>
          <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
        </button>
      {/if}
      <button type="button" role="menuitem" class="dropdown-item" onclick={openSettings}>
        <svg class="icon"><use href="#icon-settings"></use></svg> Settings
      </button>
      {#if $githubUsername}
        <button type="button" role="menuitem" class="dropdown-item" onclick={signOut}>
          <svg class="icon"><use href="#icon-log-out"></use></svg> Sign out
        </button>
      {/if}
    </div>
  {/if}
</div>
```

- [ ] **Step 4: Add the header CSS**

In `client/src/styles/_topbar.scss`, replace the `.topbar-account-menu .menu-section-label` rule with:

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
.topbar-account-header-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.topbar-account-header-avatar .icon {
  width: 18px;
  height: 18px;
  color: var(--text-dim);
}
.topbar-account-header-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.topbar-account-header-name {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar-account-header-sub {
  font-size: 12px;
  color: var(--text-dim);
}
```

- [ ] **Step 5: Run the component tests**

Run: `npx vitest run --project=components tests/client/src/components/TopbarAccount.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Update the signed-out account e2e**

In `tests/e2e/local/topbar-chrome.spec.ts`, replace the `"UI-2: signed-out account button…"` test with:

```ts
test("v2: the account button opens a menu with Settings + Sign in (signed out)", async ({ page }) => {
  const btn = page.locator("#topbar-account-mount .topbar-account-btn");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("data-tooltip", "Account");
  expect(await btn.locator('use[href="#icon-user"]').count()).toBe(1);

  await btn.click();
  await expect(page.locator('.topbar-account-menu [role="menuitem"]:has-text("Sign in with GitHub")')).toBeVisible();
  await expect(page.locator('.topbar-account-menu [role="menuitem"]:has-text("Settings")')).toBeVisible();
});
```

- [ ] **Step 7: Run the full local e2e**

```bash
npx playwright test --project=local
```
Expected: PASS — including `keybindings.spec.ts`, `preview-rendering.spec.ts` (now opening Settings via the menu), and `topbar-chrome.spec.ts`.

- [ ] **Step 8: Run the full unit suite + typecheck + build**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
```
Expected: all green.

- [ ] **Step 9: Visual check**

`npm run dev:client`, open `:5275` (signed-out). Click the account button → menu with "Not signed in" header, "Sign in with GitHub", "Settings". Click Settings → the Settings modal opens. Close it. Re-open the menu → click outside → it closes.

- [ ] **Step 10: Commit**

```bash
npm run format
git add client/src/components/TopbarAccount.svelte client/src/styles/_topbar.scss tests/client/src/components/TopbarAccount.test.ts tests/e2e/local/topbar-chrome.spec.ts
git commit -m "$(cat <<'EOF'
feat(ui): redesigned account menu — header + Settings + Sign out

The account button (signed in and out) now opens one menu: a header
(32px avatar + name + status), a divider, then Sign in with GitHub /
Settings / Sign out as appropriate. Settings lives here now instead of
its own top-bar button.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Release 1.56.0

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`
- Create: `client/public/whats-new/topbar-chrome-v2.png`, `tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs`

**Interfaces:** none.

**Context:**
- `package.json` `"version"` is `1.55.0`. `package-lock.json` has two `"version": "1.55.0"` lines (~3 and ~9). Hand-edit both.
- `CHANGELOG.md` newest section is `## [1.55.0] - 2026-09-09`. Insert above it.
- `whats-new-entries.ts` — append; shape `{version, title, description, screenshot, category}`, no date; `screenshot` matches `/^\/whats-new\/[\w-]+\.(png|jpg|webp)$/`.
- Screenshot capture pattern: copy `tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs`. Flow: `enable-dev-login.sh` → `npm run build` → `npm run dev` (:8787) → script → `pkill -f "wrangler dev"` → `disable-dev-login.sh` → verify `git diff --quiet src/worker.ts`.
- TEST-COVERAGE rows to touch: SHELL-26 (mode switcher), SHELL-27 (account button). Add a Settings-open row (SHELL-29).

- [ ] **Step 1: Version bump**

`package.json` `"version"` → `"1.56.0"`. `package-lock.json` both `"version"` lines → `"1.56.0"`. Verify `grep -n '"version": "1.5[56].0"' package.json package-lock.json` shows only `1.56.0`.

- [ ] **Step 2: CHANGELOG**

Insert above `## [1.55.0] - 2026-09-09` (real current date):

```markdown
## [1.56.0] - <today>

### Fixed

- **The mode switcher's dropdown** laid its icons above the text instead of beside it.
- **On a phone, the mode switcher's arrow** pointed sideways instead of down.

### Changed

- **The Editing / Suggesting / Viewing switcher** is now an outlined button, matching Google Docs.
- **Your avatar in the top bar** is a touch smaller, sitting inside the button rather than filling it.
- **Settings moved into the account menu** (click your avatar) — freeing a slot in the top bar. The menu now shows who you're signed in as.
```

- [ ] **Step 3: What's New entry**

Append to `WHATS_NEW_ENTRIES`:

```ts
  {
    version: "1.56.0",
    title: "Top Bar, Tidied Further",
    description:
      "The Editing/Suggesting/Viewing switcher is now an outlined button like Google Docs, and its dropdown and mobile arrow are fixed. Your avatar is a little smaller, and Settings has moved into the account menu — click your avatar to reach Settings, see who you're signed in as, or sign out.",
    screenshot: "/whats-new/topbar-chrome-v2.png",
    category: "Organization & Navigation",
  },
```

- [ ] **Step 4: Write the capture script**

`tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs`:

```js
// One-off: capture client/public/whats-new/topbar-chrome-v2.png — the
// signed-in account menu open, showing the header + Settings + Sign out.
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/topbar-chrome-v2.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 520 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.route("**/api/auth/github/me", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username: "octocat" }) }),
);
await page.goto(`${BASE}/api/dev/login?username=octocat`);
await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
await page.click("#emptyNewWorkspaceBtn").catch(() => {});
await page.keyboard.press("Escape").catch(() => {});
await page.evaluate(() => window.MDE.newDoc());
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await page.locator("#topbar-account-mount .topbar-account-btn").click();
await page.locator('.topbar-account-menu [role="menuitem"]:has-text("Sign out")').waitFor({ timeout: 3000 });
await page.waitForTimeout(200);
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1100, height: 340 } });
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
```

- [ ] **Step 5: Capture the screenshot**

```bash
git diff --quiet src/worker.ts && echo clean
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build
npm run dev > /tmp/dev-tcv2.log 2>&1 &
# wait until curl -sf http://localhost:8787/ succeeds
node tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs
pkill -f "wrangler dev"
bash tests/scripts/manual-testing/disable-dev-login.sh
git diff --quiet src/worker.ts && echo "worker.ts clean"
```

Open `client/public/whats-new/topbar-chrome-v2.png` — confirm the account menu is open with the header (octocat avatar + name), the outlined mode switcher is visible, the avatar is inset. Re-capture with a bigger `waitForTimeout` if the menu didn't render.

- [ ] **Step 6: Verify the screenshot test**

Run: `npx vitest run tests/client/src/whats-new-entries.test.ts`
Expected: PASS.

- [ ] **Step 7: TEST-COVERAGE**

In `docs/TEST-COVERAGE.md`, App-shell section:
- Extend the **SHELL-26** row's scenario text: append `; v2 (v1.56.0) — dropdown items are a real flex box (icon beside the two-line text), the caret is .mode-switcher-caret (no menu-bar collision, points down on mobile), and the button is an outlined pill`.
- Extend the **SHELL-27** row: append `; v2 (v1.56.0) — one shared menu-toggle button (signed in + out), a redesigned header (32px avatar + name + status), Settings + Sign in/out items; the avatar image is inset (32px in the 40px button)`.
- Add:
  ```markdown
  | SHELL-29 | Settings opens off `settingsModalOpen` (not a `#settingsBtn` click) — `Settings.svelte` `hidden = $derived(!$settingsModalOpen)`; the top-bar account menu's "Settings" item sets it true (signed in and out); e2e (`keybindings`, `preview-rendering`) open Settings via the account menu | component + e2e | covered | `tests/client/src/components/Settings.test.ts`, `tests/e2e/local/keybindings.spec.ts` | v1.56.0 |
  ```

- [ ] **Step 8: ROADMAP**

In `ROADMAP.md`, under "Google-Docs-style top bar & version history (2026-09-08)", after the UI-5 bullet, add:

```markdown
- **v2 — shipped v1.56.0** (spec
  `docs/superpowers/specs/2026-09-09-topbar-chrome-v2-design.md`). From
  live review: fixed the mode-switcher dropdown's icon-above-text layout
  (a shared `.dropdown-item` rule shadows its own `display: flex`) and
  its caret pointing left on mobile (an unscoped `.menu-chevron` mobile
  rotation); gave the switcher an outlined-pill look; shrank the avatar
  to a 32px image inside the 40px button; moved Settings off its own
  top-bar button into a redesigned account menu (new `settingsModalOpen`
  store).
```

- [ ] **Step 9: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
npx playwright test --project=local
```
Expected: all green. (`webkit` project needs its own browser — run `--project=local` explicitly and note `webkit` skipped if it can't be fetched, per `CLAUDE.md`.)

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/topbar-chrome-v2.png tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs docs/TEST-COVERAGE.md ROADMAP.md
git commit -m "$(cat <<'EOF'
chore: release 1.56.0 — top-bar chrome v2

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Open the PR**

```bash
git push -u origin docs/topbar-chrome-v2-spec
gh pr create --title "Top-bar chrome v2 — v1.56.0" --body "$(cat <<'EOF'
## What

From live review of the v1.54.0 top bar:

- **Fix** — the mode-switcher dropdown laid the icon above the text (a `.dropdown-item` rule in `_utilities.scss` shadows its own `display: flex`; fixed with an id-scoped rule).
- **Fix** — the mode-switcher caret pointed left on mobile (`_menu.scss`'s unscoped `.menu-chevron` mobile `rotate(90deg)`, meant for File-menu carets; scoped to `#menuBar` + renamed the mode switcher's caret class).
- **Change** — the mode switcher is an outlined pill (`border: 1px solid var(--border)` + hover/open states).
- **Change** — the top-bar avatar is a 32px image inside the 40px button (`padding: 4px`), not full-bleed.
- **Change** — Settings moved off its own top-bar button into a redesigned account menu (new `settingsModalOpen` store); the menu has a proper header (avatar + name + status) and Settings / Sign in / Sign out.

Spec: `docs/superpowers/specs/2026-09-09-topbar-chrome-v2-design.md`
Plan: `docs/superpowers/plans/2026-09-09-topbar-chrome-v2.md`

## Release

v1.56.0 — CHANGELOG (`### Fixed` + `### Changed`) + What's New entry (with screenshot) + TEST-COVERAGE (SHELL-26/27 extended, SHELL-29 added).

## Tests

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, and `npx playwright test --project=local` green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 12: Watch CI, merge on green** (after the user confirms) — `auto-tag.yml` tags `v1.56.0` → `release.yml` → Cloudflare auto-deploys.

---

## Self-Review

**1. Spec coverage:**
- Part 1 (dropdown layout, id-scoped flex, NOTE comment, test) → Task 1. ✅
- Part 2 (scope `.menu-chevron` to `#menuBar`, rename caret class, tests) → Task 2. ✅
- Part 3 (button `border` + hover/open states + test) → Task 3. ✅
- Part 4a (avatar `padding: 4px`, drop `overflow: hidden`, test) → Task 4. ✅
- Part 4b (`settingsModal` store, `Settings.svelte` rewire to `$derived`, remove `#settingsBtn`, update keybindings/preview-rendering/topbar-chrome/topbar-tooltip, `openSettings` helper, `Settings.test.ts`) → Task 5. ✅
- Part 4c (one shared toggle button, header markup both branches, `Settings`/`Sign in`/`Sign out` items, CSS, drop old `.menu-section-label` rule, `TopbarAccount.test.ts` rewrite) → Task 6. ✅
- Release (version both lockfile fields, CHANGELOG Fixed+Changed, What's New + real screenshot + capture script, TEST-COVERAGE SHELL-26/27/29, ROADMAP) → Task 7. ✅
- Non-goal "don't re-base shared `.dropdown-item` rules" — honored (id-scoped fix + NOTE only). ✅
- Non-goal "no Settings entry in a menu-bar menu" — honored. ✅
- Non-goal "don't change what Settings contains" — honored (only its open mechanism changes). ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". `<today>`/`<date>` in Task 7 are fill-at-commit tokens with an explicit "real current date" instruction. Line-number refs (`~line 348`, `~53`) are hints with enough surrounding code quoted to locate exactly. The Task 5 note that `keybindings`/`preview-rendering` e2e "wait for Task 6" is a real sequencing constraint, restated in Task 6 Step 7. Acceptable.

**3. Type/name consistency:**
- `settingsModalOpen: Writable<boolean>` — defined Task 5 Step 1, consumed in `Settings.svelte` (Task 5 Step 4), `TopbarAccount.svelte` (Task 6 Step 3), and both test files.
- `openSettings(page)` — defined Task 5 Step 7, used in Task 5 Steps 8 and Task 6 Step 7's suites.
- `.mode-switcher-caret` — introduced Task 2 Step 3 (component + `_topbar.scss`), asserted in Task 2 Step 1's test.
- `.topbar-account-header` / `-avatar` / `-text` / `-name` / `-sub` — defined in Task 6 Step 3 markup + Step 4 CSS, asserted in Task 6 Step 1 (`.topbar-account-header-name`).
- `.topbar-account-btn` / `.topbar-account-menu` / `.topbar-account-avatar` — carried over from v1.54.0, unchanged names.
- `#icon-user` / `#icon-settings` / `#icon-log-out` / `#icon-github` — all exist in the sprite (verified: `#icon-user` added in v1.54.0).
- `.dropdown-divider` — existing class (used by `#shareDropdownMenu`).
- Screenshot path `client/public/whats-new/topbar-chrome-v2.png` — consistent across the capture script, the What's New entry, and the file list.

No gaps found.
