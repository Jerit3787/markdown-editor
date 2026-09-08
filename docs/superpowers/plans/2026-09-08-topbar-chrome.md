# Top-bar chrome pass (UI-1 / UI-2 / UI-4 / UI-5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the top-bar action cluster closer to Google Docs' chrome — circular icon buttons app-wide, a GitHub avatar + account menu, a label-less mode switcher, and CSS hover tooltips.

**Architecture:** Four independent slices. Three are pure CSS/markup (`_utilities.scss` radius, a new `_tooltip.scss`, `ModeSwitcher.svelte` label gating). One is a small new Svelte 5 component (`TopbarAccount.svelte`) mounted into the existing vanilla-HTML top bar via a mount `<div>` + `main.ts`, reading the existing `githubUsername` store. No server changes; sign-out reuses `POST /api/auth/github/logout`; the avatar image is the public `https://github.com/<user>.png` redirect.

**Tech Stack:** TypeScript, Svelte 5 runes, SCSS (`@use` modules via `client/src/style.scss`), Vitest (`unit` + `components` browser projects), Playwright (`local` project, client-only vite dev on :5275).

**Spec:** `docs/superpowers/specs/2026-09-08-topbar-chrome-design.md`

## Global Constraints

- Two `tsconfig.json`s checked separately — root strict, `client/tsconfig.json` relaxed. New client code under `client/src/`.
- Svelte 5 runes only (`$state`, `$derived`, `$props`). Component test files go in `tests/client/src/components/*.test.ts` (routes them to the `components` Vitest project — real headless Chromium).
- `npm run format` (Prettier) and `npm run typecheck` must pass before every commit.
- Keep top-bar button **sizes** (40px box) and **accent colour tokens** unchanged — only `border-radius` changes and one new item is added (`feedback_topbar_sizing_locked`).
- Dark theme is the `[data-theme="dark"]` attribute selector (NOT a media query) — any new colour token is defined under both `:root` and `[data-theme="dark"]` in `client/src/styles/_variables.scss`.
- User-facing release: bump **minor** to `1.54.0` in `package.json` + **both** `"version"` fields in `package-lock.json` (hand-edit); add a `## [1.54.0] - <today>` section to `CHANGELOG.md` (Keep a Changelog: `### Added` / `### Changed`); append one entry to `client/src/whats-new-entries.ts` **with a real committed screenshot** at `client/public/whats-new/topbar-chrome.png`; `whats-new-entries.test.ts` fails if that file is absent.
- `docs/TEST-COVERAGE.md` gets rows for the new coverage.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `client/src/styles/_utilities.scss` | `.icon-btn` base radius → `50%` | 1 |
| `tests/e2e/local/topbar-chrome.spec.ts` (new) | e2e: buttons render circular; overflow rows don't; tooltip on hover; account button states | 1, 2, 4 |
| `client/src/styles/_tooltip.scss` (new) | `[data-tooltip]::after` hover/focus tooltip | 2 |
| `client/src/style.scss` | register `@use "./styles/tooltip"` | 2 |
| `client/src/styles/_variables.scss` | `--tooltip-bg` / `--tooltip-fg` tokens (light + dark) | 2 |
| `client/index.html` | `title=` → `data-tooltip=` on top-bar buttons; add `#icon-user` sprite; add `#topbar-account-mount` | 2, 4 |
| `client/src/components/ModeSwitcher.svelte` | gate `.mode-switcher-label` on single-mode; add `data-tooltip` | 3 |
| `client/src/styles/_topbar.scss` | mode-switcher pill radius/padding; account button sizing | 3, 4 |
| `tests/client/src/components/ModeSwitcher.test.ts` | label present iff single mode | 3 |
| `client/src/components/TopbarAccount.svelte` (new) | avatar + account menu / signed-out sign-in button | 4 |
| `client/src/main.ts` | `mount(TopbarAccount, …)` | 4 |
| `tests/client/src/components/TopbarAccount.test.ts` (new) | signed-in / signed-out / img-error paths | 4 |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/topbar-chrome.png`, `ROADMAP.md`, `docs/TEST-COVERAGE.md` | release | 5 |
| `tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs` (new) | one-off What's New screenshot capture | 5 |

---

## Task 1: UI-1 — circular icon buttons application-wide

**Files:**
- Modify: `client/src/styles/_utilities.scss:82` (the `border-radius` line inside `.icon-btn`)
- Create: `tests/e2e/local/topbar-chrome.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. The e2e spec file `tests/e2e/local/topbar-chrome.spec.ts` is extended by Tasks 2 and 4 (append tests, don't recreate it).

**Context an implementer needs:**
- `.icon-btn` base (`_utilities.scss:75-92`): `border: none; background: transparent; color: var(--text); font-size: 16px; width: 32px; height: 32px; border-radius: 6px; …`. In `#topbarActionsCol` it's overridden to `40×40` (`_topbar.scss:63`), radius inherited.
- The **only** explicit `border-radius` override on any `.icon-btn` is `.toolbar-overflow .icon-btn` / `.toolbar-buttons #sidebarToggleOut` (`_topbar.scss:203-208`): `width: auto; height: auto; padding: 5px 9px; border-radius: 5px`. It already wins on specificity — the base change does not touch it. That's the intended walkback (a dropdown-list row, not a chrome button).
- Other `.icon-btn` sites — `#menuBar .icon-btn` (`_menu.scss:241`), `.workspace-row .icon-btn` (`_share-workspace.scss:382`), `.image-item .icon-btn` (`_utilities.scss:446`), mobile `.icon-btn` (`_utilities.scss:614`) — are all square boxes with no radius of their own; they become circles, which is desired.
- Local e2e: specs import `{ test, expect }` from `./support/fixtures` (seeds a local doc, navigates, dismisses What's New via `mde:whatsNewSeen`). Client-only vite dev on `:5275`; `/api/*` returns 404 (so the app is always signed-out in this suite).
- `getComputedStyle(el).borderRadius` on a `50%` rule resolves to a px value equal to half the box (e.g. `"20px"` for a 40px button). Assert `parseFloat(borderRadius) >= boxWidth * 0.4`.

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/local/topbar-chrome.spec.ts`:

```ts
import { test, expect } from "./support/fixtures";

test("UI-1: top-bar icon buttons are circular", async ({ page }) => {
  const radius = (sel: string) =>
    page.locator(sel).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { br: parseFloat(cs.borderRadius), w: el.getBoundingClientRect().width };
    });

  const vh = await radius("#versionHistoryBtn");
  expect(vh.br).toBeGreaterThanOrEqual(vh.w * 0.4); // ~50% → half the box

  const settings = await radius("#settingsBtn");
  expect(settings.br).toBeGreaterThanOrEqual(settings.w * 0.4);

  // The formatting-toolbar overflow ("⋯") button — forced visible by a
  // narrow viewport — keeps a small radius (it's a dropdown-list trigger,
  // not a chrome button). Its rule (.toolbar-overflow .icon-btn) already
  // sets border-radius: 5px + width/height: auto and wins on specificity.
  await page.setViewportSize({ width: 640, height: 800 });
  const overflowBtn = page.locator(".toolbar-overflow .icon-btn");
  await expect(overflowBtn).toBeVisible();
  const r = await overflowBtn.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius));
  expect(r).toBeLessThan(12);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx playwright test --project=local tests/e2e/local/topbar-chrome.spec.ts`
Expected: FAIL — `#versionHistoryBtn` border-radius is `6` (< `40 * 0.4 = 16`).

(If the local Playwright browser is missing, see `CLAUDE.md` → "Sandboxed Claude Code environments" for the `executablePath` workaround; revert it before committing.)

- [ ] **Step 3: Make the change**

In `client/src/styles/_utilities.scss`, inside `.icon-btn` (line ~82), change:

```scss
  border-radius: 6px;
```
to:
```scss
  border-radius: 50%;
```

- [ ] **Step 4: Run the test, expect pass**

Run: `npx playwright test --project=local tests/e2e/local/topbar-chrome.spec.ts`
Expected: PASS.

- [ ] **Step 5: Visual walkback check**

Run `npm run build && npm run dev:client`, open `http://localhost:5275`. Confirm each is a clean circle (not an oval) and reads right:
- Top bar: comments, version history, settings, save-status (the cloud).
- Menu bar hamburger / any `#menuBar .icon-btn`.
- Sidebar header: `#sidebarToggleIn`, `#newDocBtn`.
- Open a modal with a header `?`/icon quick-action (e.g. Manage Images) — its `.icon-btn`.
- Open the formatting toolbar's "⋯" overflow — its rows must still be small rounded rects.

For **any** button that renders an oval or reads wrong, add a scoped `border-radius` override restoring its prior value next to that context's existing rule, and note it in the commit body. Expected outcome from the spec's analysis: **no overrides needed** (every non-overflow `.icon-btn` is square). If that holds, state "no walkback overrides needed" in the commit body.

- [ ] **Step 6: Commit**

```bash
git add client/src/styles/_utilities.scss tests/e2e/local/topbar-chrome.spec.ts
git commit -m "$(cat <<'EOF'
feat(ui): circular icon buttons application-wide (UI-1)

.icon-btn base border-radius 6px → 50%. The toolbar-overflow menu rows
keep their explicit 5px (a dropdown list, not a chrome button) — already
overridden, untouched. Walkback overrides needed: none.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: UI-5 — CSS-only hover/focus tooltip

**Files:**
- Create: `client/src/styles/_tooltip.scss`
- Modify: `client/src/style.scss` (add `@use "./styles/tooltip";` after `@use "./styles/topbar";`)
- Modify: `client/src/styles/_variables.scss` (add two tokens under `:root` and `[data-theme="dark"]`)
- Modify: `client/index.html` (migrate `title=` → `data-tooltip=` on the named buttons)
- Modify: `tests/e2e/local/topbar-chrome.spec.ts` (append a test)
- Create: `tests/client/src/topbar-tooltip.test.ts` (unit — DOM attribute check on the built `index.html`)

**Interfaces:**
- Consumes: nothing.
- Produces: the `[data-tooltip]` CSS contract — any element with a `data-tooltip="text"` attribute shows `text` as a chip on `:hover` / `:focus-visible`. Tasks 3 and 4 rely on this.

**Context an implementer needs:**
- `client/src/style.scss` is the SCSS entry — a flat list of `@use "./styles/<name>";`. `variables` is first, `utilities` near-last, `print` last.
- `_variables.scss` top: `:root { --bg: …; --accent: …; … }` then `[data-theme="dark"] { --bg: …; … }`. Add new tokens in both blocks.
- `#topbar` is `z-index: 300`, `position: relative`, `display: grid`, **no `overflow: hidden`**. `#topbarActionsCol` (`_topbar.scss:52`) and `.topbar-actions` (`_topbar.scss:47`) have no `overflow` — a chip positioned below a button escapes fine.
- Buttons in `client/index.html` with a `title=` to migrate (search each `id`): `#saveStatusBtn` (`title="Saved locally"` — but this is dynamic, set by app.ts; see below), `#commentsBtn` (`title="Comments"`), `#versionHistoryBtn` (`title="Version history"`), `#suggestionsBtn` (`title="Suggestions"`), `#settingsBtn` (`title="Settings"`), `#sidebarToggleIn` (`title="Hide documents panel"`), `#newDocBtn` (`title="New document"`).
- `#saveStatusBtn`'s `title` is **rewritten at runtime** by `app.ts` (save-status changes: "Saved locally" / "Saving…" / etc.). Grep `app.ts` for `saveStatusBtn` + `.title` / `setAttribute("title"` — **migrate those assignments to `dataset.tooltip` / `setAttribute("data-tooltip", …)` in app.ts too**, and change the static attribute in `index.html`. If app.ts also sets `aria-label` there, leave that as-is.
- `#shareBtn` has `title="Share"` and a visible "Share" label — **remove its `title`, add no `data-tooltip`** (redundant).
- Keep every `aria-label` exactly as-is.

- [ ] **Step 1: Write the failing unit test**

Create `tests/client/src/topbar-tooltip.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const html = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../client/index.html"),
  "utf8",
);

describe("UI-5: top-bar tooltip attribute migration", () => {
  const ids = ["commentsBtn", "versionHistoryBtn", "settingsBtn", "newDocBtn"];
  for (const id of ids) {
    it(`#${id} has data-tooltip and no title=`, () => {
      const tag = html.match(new RegExp(`<button[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "";
      expect(tag, `#${id} <button> tag not found`).not.toBe("");
      expect(tag).toContain("data-tooltip=");
      expect(tag).not.toMatch(/\btitle=/);
      expect(tag).toContain("aria-label=");
    });
  }

  it("#shareBtn has neither title= nor data-tooltip (it has a visible label)", () => {
    const tag = html.match(/<button[^>]*\bid="shareBtn"[^>]*>/)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toMatch(/\btitle=/);
    expect(tag).not.toContain("data-tooltip=");
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/client/src/topbar-tooltip.test.ts`
Expected: FAIL — the buttons still have `title=` and no `data-tooltip`.

- [ ] **Step 3: Add the colour tokens**

In `client/src/styles/_variables.scss`, add to the `:root { … }` block:

```scss
  --tooltip-bg: #1f2430;
  --tooltip-fg: #ffffff;
```

and to the `[data-theme="dark"] { … }` block:

```scss
  --tooltip-bg: #3a3d42;
  --tooltip-fg: #f3f3f3;
```

- [ ] **Step 4: Create the tooltip partial**

Create `client/src/styles/_tooltip.scss`:

```scss
/* UI-5 — a CSS-only hover/focus tooltip. Any element with
   data-tooltip="…" shows that text as a chip below it on :hover and
   :focus-visible. Decorative only — screen readers use the element's
   own aria-label, which is left in place. Known limitation: an ancestor
   with overflow:hidden clips the chip; no current consumer has one.
   A JS-positioned upgrade is left to the accessibility pass. */
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
  background: var(--tooltip-bg);
  color: var(--tooltip-fg);
  font: 500 12px/1.3 var(--sans);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  z-index: 400;
}
@media (prefers-reduced-motion: no-preference) {
  [data-tooltip]::after {
    transition: opacity 0.12s ease;
  }
}
[data-tooltip]:hover::after,
[data-tooltip]:focus-visible::after {
  opacity: 1;
}
```

- [ ] **Step 5: Register the partial**

In `client/src/style.scss`, add after the `@use "./styles/topbar";` line:

```scss
@use "./styles/tooltip";
```

- [ ] **Step 6: Migrate the markup**

In `client/index.html`, for `#commentsBtn`, `#versionHistoryBtn`, `#suggestionsBtn`, `#settingsBtn`, `#sidebarToggleIn`, `#newDocBtn`: replace `title="X"` with `data-tooltip="X"` (keep `aria-label`). For `#saveStatusBtn`: change the static `title="Saved locally"` to `data-tooltip="Saved locally"`. For `#shareBtn`: delete `title="Share"`.

Then in `client/src/app.ts`, find every runtime write to `#saveStatusBtn`'s `title` (grep `saveStatusBtn`), e.g. `saveStatusBtn.title = "…"` or `.setAttribute("title", …)`, and change each to set `data-tooltip` instead (`saveStatusBtn.dataset.tooltip = "…"` / `.setAttribute("data-tooltip", …)`). Leave any `aria-label` writes there untouched.

- [ ] **Step 7: Run the unit test, expect pass**

Run: `npx vitest run tests/client/src/topbar-tooltip.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the e2e hover test**

Append to `tests/e2e/local/topbar-chrome.spec.ts`:

```ts
test("UI-5: hovering a top-bar icon button shows its tooltip chip", async ({ page }) => {
  const btn = page.locator("#versionHistoryBtn");
  await expect(btn).toHaveAttribute("data-tooltip", "Version history");

  const chipOpacity = () =>
    btn.evaluate((el) => getComputedStyle(el, "::after").opacity);

  expect(await chipOpacity()).toBe("0");
  await btn.hover();
  await expect.poll(chipOpacity).toBe("1");
});
```

- [ ] **Step 9: Run it, expect pass**

Run: `npx playwright test --project=local tests/e2e/local/topbar-chrome.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 10: Typecheck + format + commit**

```bash
npm run typecheck && npm run format
git add client/src/styles/_tooltip.scss client/src/style.scss client/src/styles/_variables.scss client/index.html client/src/app.ts tests/client/src/topbar-tooltip.test.ts tests/e2e/local/topbar-chrome.spec.ts
git commit -m "$(cat <<'EOF'
feat(ui): CSS-only hover/focus tooltip on top-bar buttons (UI-5)

New _tooltip.scss: [data-tooltip]::after chip on :hover / :focus-visible,
theme-aware via --tooltip-bg/-fg, prefers-reduced-motion guarded. The
top-bar buttons migrate title= → data-tooltip= (aria-label unchanged);
#saveStatusBtn's runtime title writes in app.ts move too. #shareBtn
drops its redundant title.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: UI-4 — compact mode switcher

**Files:**
- Modify: `client/src/components/ModeSwitcher.svelte`
- Modify: `client/src/styles/_topbar.scss` (`#topbarActionsCol .mode-switcher-btn`, ~line 332)
- Modify: `tests/client/src/components/ModeSwitcher.test.ts`

**Interfaces:**
- Consumes: `[data-tooltip]` CSS from Task 2.
- Consumes (existing): `stores/collabMode` — `effectiveMode` (`Readable<Mode|null>`), `modesAllowed` (`Readable<Mode[]>`), `collabRole` (`Readable<Role|null>`), `setChosenMode(m: Mode)`, `type Mode = "editing"|"suggesting"|"viewing"`; test helper `enterCollabRoom(remoteId: string, role: "editor"|"reviewer"|"viewer", isOwner: boolean)` / `leaveCollabRoom()`.
- Produces: nothing importable.

**Context an implementer needs:**
- Current `ModeSwitcher.svelte` markup (lines 36-56):

```svelte
{#if $collabRole && $effectiveMode}
  <div class="mode-switcher dropdown">
    <button type="button" class="mode-switcher-btn icon-btn" onclick={toggle} aria-haspopup="menu" aria-expanded={open}>
      <svg class="icon"><use href="#{ICONS[$effectiveMode]}"></use></svg>
      <span class="mode-switcher-label">{LABELS[$effectiveMode]}</span>
      {#if $modesAllowed.length > 1}<svg class="icon menu-chevron"><use href="#icon-chevron-down"></use></svg>{/if}
    </button>
    …
```

- `LABELS: Record<Mode,string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" }` (already defined at top of file).
- `_topbar.scss:332` `#topbarActionsCol .mode-switcher-btn { width: auto; height: 40px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border-radius: 10px; }`. After Task 1, `.icon-btn`'s `border-radius: 50%` does NOT reach this — this rule's explicit `border-radius: 10px` wins on `#id` specificity. Keep an explicit radius here.
- `_topbar.scss:370` `@media (max-width: 780px) { #topbarActionsCol .mode-switcher-label { display: none } #topbarActionsCol .mode-switcher-btn { padding: 0 8px } }` — still correct for the single-mode case; leave it.
- `ModeSwitcher.test.ts` existing tests: "an editor sees all three modes…", "a viewer's switcher shows Viewing…" (asserts `getByRole("button", { name: /Viewing/i })` — an accessible-name match; the button's `aria-label`? No — it has no `aria-label`, so the accessible name comes from its text content. For a viewer, single-mode, the label stays → still matches. For an editor, multi-mode, the label goes → the "an editor sees all three modes" test clicks `getByRole("button", { name: /Editing/i })`. **This will break** — after the change the collapsed button has no "Editing" text.).
- Fix for that existing test: give the button an `aria-label={LABELS[$effectiveMode]}` so its accessible name is always the mode name regardless of visible text. That also satisfies the `data-tooltip` intent for screen readers and keeps `getByRole("button", { name: /Editing/i })` working.

- [ ] **Step 1: Update the failing test first**

In `tests/client/src/components/ModeSwitcher.test.ts`, add a new test:

```ts
test("UI-4: the label is hidden when the collaborator can switch modes, shown when they can't", async () => {
  enterCollabRoom("r1", "editor", true); // 3 modes
  let screen = await render(ModeSwitcher);
  await expect.poll(() => screen.container.querySelector(".mode-switcher-label")).toBeNull();

  leaveCollabRoom();
  enterCollabRoom("r3", "viewer", false); // 1 mode
  screen = await render(ModeSwitcher);
  await expect.poll(() => screen.container.querySelector(".mode-switcher-label")?.textContent?.trim()).toBe("Viewing");
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts -t "UI-4"`
Expected: FAIL — `.mode-switcher-label` is always present today.

- [ ] **Step 3: Edit the component**

In `client/src/components/ModeSwitcher.svelte`, replace the `<button …>` opening tag and the label line:

```svelte
    <button
      type="button"
      class="mode-switcher-btn icon-btn"
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={LABELS[$effectiveMode]}
      data-tooltip={LABELS[$effectiveMode]}
    >
      <svg class="icon"><use href="#{ICONS[$effectiveMode]}"></use></svg>
      {#if $modesAllowed.length < 2}
        <span class="mode-switcher-label">{LABELS[$effectiveMode]}</span>
      {/if}
      {#if $modesAllowed.length > 1}<svg class="icon menu-chevron"><use href="#icon-chevron-down"></use></svg>{/if}
    </button>
```

- [ ] **Step 4: Run the component tests, expect pass**

Run: `npx vitest run --project=components tests/client/src/components/ModeSwitcher.test.ts`
Expected: PASS — all tests, including the pre-existing "an editor sees all three modes" (now matching on `aria-label`) and "a viewer's switcher shows Viewing".

- [ ] **Step 5: Tighten the CSS**

In `client/src/styles/_topbar.scss`, in the `#topbarActionsCol .mode-switcher-btn` rule (~line 332), change `gap: 6px;` → `gap: 4px;`, `padding: 0 12px;` → `padding: 0 10px;`, and `border-radius: 10px;` → `border-radius: 20px;` (a pill — stays a rounded pill in both the icon+caret and icon+label states, never an oval).

- [ ] **Step 6: Visual check**

`npm run build && npm run dev` (needs a shared workspace to see the switcher — or temporarily `enterCollabRoom` via devtools console: `import("/src/stores/collabMode.ts").then(m => m.enterCollabRoom("x","editor",true))`). Confirm: editor → icon + caret, no text, hover shows "Editing"; a viewer → icon + "Viewing". Neither is an oval.

- [ ] **Step 7: Commit**

```bash
npm run typecheck && npm run format
git add client/src/components/ModeSwitcher.svelte client/src/styles/_topbar.scss tests/client/src/components/ModeSwitcher.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): compact mode switcher — icon + caret only when switchable (UI-4)

The mode switcher drops its text label when the collaborator has 2+
modes to pick (relies on the new data-tooltip + a mode-name aria-label);
a single-mode viewer keeps the "Viewing" label. Button stays a pill.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: UI-2 — top-bar account button + avatar

**Files:**
- Create: `client/src/components/TopbarAccount.svelte`
- Modify: `client/index.html` (add `#icon-user` sprite; add `#topbar-account-mount`)
- Modify: `client/src/main.ts` (mount)
- Modify: `client/src/styles/_topbar.scss` (`.topbar-account*` rules)
- Create: `tests/client/src/components/TopbarAccount.test.ts`
- Modify: `tests/e2e/local/topbar-chrome.spec.ts` (append signed-out test)

**Interfaces:**
- Consumes: `[data-tooltip]` CSS (Task 2); `.icon-btn` (circular, Task 1); `stores/github` — `export const githubUsername: Writable<string | null>`; `window.MDE.openGithubSignInPopup(): void` and `window.MDE.closeAllDropdowns(): void` (both in `MDEBridge`, `client/src/types.ts`).
- Produces: nothing importable — a mounted component.

**Context an implementer needs:**
- `client/src/stores/github.ts`: `export const githubUsername = writable<string | null>(null);` — populated by `gist.ts` from `/api/auth/github/me` on load and auth changes. No other wiring needed.
- Sign-out (from `Settings.svelte:39`): `async function disconnect() { await fetch("/api/auth/github/logout", { method: "POST" }); location.reload(); }`.
- The dropdown pattern to mirror is `ModeSwitcher.svelte`'s: `let open = $state(false)`, `toggle()` calls `window.MDE.closeAllDropdowns?.()` then flips `open`, `onMount` adds a `document` click listener that closes when the click is outside `.mode-switcher` (here: `.topbar-account`), plus an Escape handler. Menu markup: `<div class="dropdown-menu …" role="menu">` with `<button role="menuitem" class="dropdown-item">` children and a `<div class="menu-section-label">` header (all base classes already exist).
- `#shareDropdownMenu` shows the right-alignment convention: `style="right: 0; min-width: 260px"`.
- Mount point placement: `client/index.html` line ~398, `.topbar-actions` ends with `<button id="settingsBtn" …>…</button>`. Add `<div id="topbar-account-mount"></div>` immediately after that button, still inside `.topbar-actions`.
- `main.ts`: mounts are a flat list of `mount(Component, { target: document.getElementById("x-mount")! });`. Add near the other top-bar mounts (after `mount(ModeSwitcher, …)`).
- Sprite: add `#icon-user` (Feather `user`) near `#icon-users` (`client/index.html:167`). Feather `user` paths:

```html
<symbol id="icon-user" viewBox="0 0 24 24">
  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
  <circle cx="12" cy="7" r="4" />
</symbol>
```

- The sprite `<symbol>`s render via `<svg class="icon"><use href="#icon-user"></use></svg>`; stroke styling is global (`_utilities.scss:~730` `svg.icon` — `fill: none; stroke: currentColor; …`).
- `vitest-browser-svelte` `render()` + `tests/client/src/components/*.test.ts` → `components` project. Stub `window.MDE` as `new Proxy({}, { get: () => vi.fn() })` (see `ModeSwitcher.test.ts`). Stub `fetch` with `vi.fn()` and `location.reload` — in the browser project `location` is real; use `vi.stubGlobal("fetch", fn)` and spy reload via `Object.defineProperty(window, "location", { value: { ...window.location, reload: vi.fn() } })` OR simpler: have `signOut` call a small indirection. Keep it simple: assert `fetch` was called with the logout URL and don't assert the reload.

- [ ] **Step 1: Write the failing component test**

Create `tests/client/src/components/TopbarAccount.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import TopbarAccount from "../../../../client/src/components/TopbarAccount.svelte";
import { githubUsername } from "../../../../client/src/stores/github";

let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  githubUsername.set(null);
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}"))));
  reloadSpy = vi.fn();
  // location.reload() would actually reload the test runner page — stub it.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: reloadSpy },
  });
});

test("signed out: renders a person-icon button that opens the sign-in popup", async () => {
  const openSpy = vi.fn();
  window.MDE = new Proxy({ openGithubSignInPopup: openSpy }, { get: (t, k) => (t as any)[k] ?? vi.fn() }) as unknown as typeof window.MDE;
  const screen = await render(TopbarAccount);
  const btn = screen.getByRole("button", { name: /sign in/i });
  await expect.element(btn).toBeVisible();
  expect(screen.container.querySelector('use[href="#icon-user"]')).not.toBeNull();
  await btn.click();
  expect(openSpy).toHaveBeenCalled();
});

test("signed in: renders the avatar image and a Sign out item that POSTs to logout", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLImageElement;
  expect(img).not.toBeNull();
  expect(img.src).toContain("github.com/octocat.png");

  await screen.getByRole("button", { name: "octocat" }).click();
  await screen.getByRole("menuitem", { name: /sign out/i }).click();
  expect(fetch).toHaveBeenCalledWith("/api/auth/github/logout", { method: "POST" });
  await expect.poll(() => reloadSpy.mock.calls.length).toBeGreaterThan(0);
});

test("signed in: an avatar load error falls back to the person glyph", async () => {
  githubUsername.set("ghost");
  const screen = await render(TopbarAccount);
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLImageElement;
  img.dispatchEvent(new Event("error"));
  await expect.poll(() => screen.container.querySelector("img.topbar-account-avatar")).toBeNull();
  expect(screen.container.querySelector('use[href="#icon-user"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run --project=components tests/client/src/components/TopbarAccount.test.ts`
Expected: FAIL — module `TopbarAccount.svelte` does not exist.

- [ ] **Step 3: Create the component**

Create `client/src/components/TopbarAccount.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { githubUsername } from "../stores/github";

  let open = $state(false);
  let imgFailed = $state(false);

  function toggle() {
    window.MDE.closeAllDropdowns?.();
    open = !open;
  }
  function signIn() {
    window.MDE.openGithubSignInPopup();
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

  // Reset the image-failed flag if the user changes (sign out → sign in as someone else).
  $effect(() => {
    $githubUsername;
    imgFailed = false;
  });
</script>

{#if $githubUsername}
  <div class="topbar-account dropdown">
    <button
      type="button"
      class="topbar-account-btn icon-btn"
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={$githubUsername}
      data-tooltip={$githubUsername}
    >
      {#if !imgFailed}
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
      <div class="dropdown-menu topbar-account-menu" role="menu" style="right: 0; min-width: 200px">
        <div class="menu-section-label">{$githubUsername}</div>
        <button type="button" role="menuitem" class="dropdown-item" onclick={signOut}>
          <svg class="icon"><use href="#icon-log-out"></use></svg> Sign out
        </button>
      </div>
    {/if}
  </div>
{:else}
  <button
    type="button"
    class="topbar-account-btn icon-btn"
    onclick={signIn}
    aria-label="Sign in with GitHub"
    data-tooltip="Sign in"
  >
    <svg class="icon"><use href="#icon-user"></use></svg>
  </button>
{/if}
```

- [ ] **Step 4: Add the sprite + mount point in `client/index.html`**

After the `<symbol id="icon-users" …>…</symbol>` block, add:

```html
      <symbol id="icon-user" viewBox="0 0 24 24">
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </symbol>
```

After `<button id="settingsBtn" …>…</button>` (still inside `.topbar-actions`), add:

```html
            <div id="topbar-account-mount"></div>
```

- [ ] **Step 5: Mount in `client/src/main.ts`**

After the `mount(ModeSwitcher, { target: document.getElementById("mode-switcher-mount")! });` line, add:

```ts
import TopbarAccount from "./components/TopbarAccount.svelte";
```
(with the other component imports at the top) and:
```ts
mount(TopbarAccount, { target: document.getElementById("topbar-account-mount")! });
```

- [ ] **Step 6: Run the component tests, expect pass**

Run: `npx vitest run --project=components tests/client/src/components/TopbarAccount.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Style it**

In `client/src/styles/_topbar.scss`, at the end of the file, add:

```scss
/* UI-2 — the GitHub account button / avatar, last item in the top-bar
   actions. 40px circle to match the neighbouring #topbarActionsCol
   .icon-btn; the avatar image fills it edge to edge. */
#topbarActionsCol .topbar-account-btn {
  width: 40px;
  height: 40px;
  padding: 0;
  overflow: hidden;
}
#topbarActionsCol .topbar-account-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 50%;
}
.topbar-account {
  position: relative;
}
.topbar-account-menu .menu-section-label {
  /* the username header — keep it readable, not clipped */
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 8: Add the signed-out e2e test**

Append to `tests/e2e/local/topbar-chrome.spec.ts` (the `local` suite is always signed-out — `/api/*` 404s):

```ts
test("UI-2: signed-out account button shows a person icon and a 'Sign in' tooltip", async ({ page }) => {
  const btn = page.locator("#topbar-account-mount .topbar-account-btn");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("data-tooltip", "Sign in");
  await expect(btn).toHaveAttribute("aria-label", "Sign in with GitHub");
  expect(await btn.locator('use[href="#icon-user"]').count()).toBe(1);
});
```

- [ ] **Step 9: Run e2e + full unit suite + typecheck**

```bash
npx playwright test --project=local tests/e2e/local/topbar-chrome.spec.ts
npm test
npm run typecheck
```
Expected: all PASS.

- [ ] **Step 10: Visual check**

`npm run build && npm run dev:client`, open `:5275` — a circular person-icon button at the end of the top bar; hover shows "Sign in". (The signed-in avatar path needs a real OAuth session — verify it in Task 5's screenshot capture, which sets one up.)

- [ ] **Step 11: Commit**

```bash
npm run format
git add client/src/components/TopbarAccount.svelte client/index.html client/src/main.ts client/src/styles/_topbar.scss tests/client/src/components/TopbarAccount.test.ts tests/e2e/local/topbar-chrome.spec.ts
git commit -m "$(cat <<'EOF'
feat(ui): GitHub avatar + account menu in the top bar (UI-2)

New TopbarAccount.svelte, mounted last in the top-bar actions. Signed in:
a circular avatar (github.com/<user>.png, #icon-user fallback on error) →
a menu with the username + Sign out (POST /api/auth/github/logout). Signed
out: a person-icon button → the GitHub sign-in popup. New #icon-user
sprite. No server changes; SignedOutIndicator is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Release 1.54.0

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Create: `client/public/whats-new/topbar-chrome.png`
- Create: `tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs`
- Modify: `ROADMAP.md`
- Modify: `docs/TEST-COVERAGE.md`

**Interfaces:** none.

**Context an implementer needs:**
- `package.json` `"version"` is currently `1.53.0`. `package-lock.json` has **two** `"version": "1.53.0"` lines (top-level and `packages."".version`) — hand-edit both.
- `CHANGELOG.md` newest section is `## [1.53.0] - 2026-09-08`. Add the new one above it.
- `client/src/whats-new-entries.ts`: `WHATS_NEW_ENTRIES` array, oldest-first, append at the end. Shape: `{ version, title, description, screenshot, category }` — **no date field**. `category` must be one of `"Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation"`. `screenshot` must match `/^\/whats-new\/[\w-]+\.(png|jpg|webp)$/`.
- `whats-new-entries.test.ts` asserts the screenshot file exists on disk — capture it before/with this commit.
- Screenshot capture pattern: see `tests/scripts/manual-testing/capture-request-access-screenshot.mjs` — it uses `playwright`, `bash tests/scripts/manual-testing/enable-dev-login.sh` → `npm run build` → `npm run dev` (wrangler, :8787) → the script → `disable-dev-login.sh`. The `enable-dev-login.sh` refuses if `src/worker.ts` has uncommitted changes — none here, so it's fine. **After capture, run `bash tests/scripts/manual-testing/disable-dev-login.sh` and `git diff --quiet src/worker.ts`.**
- `ROADMAP.md`: the section "Google-Docs-style top bar & version history (2026-09-08)" lists UI-1..UI-5. Mark UI-1/2/4/5 shipped; resolve UI-3.

- [ ] **Step 1: Version bump**

Edit `package.json` `"version"` → `"1.54.0"`. Edit both `"version"` lines in `package-lock.json` → `"1.54.0"`.

- [ ] **Step 2: CHANGELOG**

Add above `## [1.53.0]` in `CHANGELOG.md`:

```markdown
## [1.54.0] - 2026-09-08

### Added

- **Your GitHub account in the top bar.** When you're signed in, your avatar sits at the end of the top bar — click it to see your username or sign out. Signed out, it's a sign-in button.

### Changed

- **The top bar looks a little more like Google Docs.** Icon buttons are round, buttons show a small label when you hover or tab to them, and the Editing/Suggesting/Viewing switcher is more compact when you can switch.
```

(Use the real current date if not 2026-09-08.)

- [ ] **Step 3: What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "1.54.0",
    title: "A Tidier Top Bar",
    description:
      "The top bar picks up a few Google-Docs habits: round icon buttons, a small label when you hover or keyboard-focus one, and a more compact Editing/Suggesting/Viewing switcher. When you're signed in with GitHub, your avatar now sits at the end of the bar — click it for your username or to sign out.",
    screenshot: "/whats-new/topbar-chrome.png",
    category: "Organization & Navigation",
  },
```

- [ ] **Step 4: Write the screenshot capture script**

Create `tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs`:

```js
// One-off: capture client/public/whats-new/topbar-chrome.png — the
// signed-in top bar with the avatar + a tooltip visible.
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/topbar-chrome.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 380 }, deviceScaleFactor: 2 });
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
await page.hover("#versionHistoryBtn");
await page.waitForTimeout(300);
// Just the top bar.
const bar = page.locator("#topbar");
await bar.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
```

- [ ] **Step 5: Capture the screenshot**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build
npm run dev > /tmp/dev-topbar.log 2>&1 &
# wait until curl -sf http://localhost:8787/ succeeds
node tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs
pkill -f "wrangler dev"
bash tests/scripts/manual-testing/disable-dev-login.sh
git diff --quiet src/worker.ts && echo "worker.ts clean"
```

Open `client/public/whats-new/topbar-chrome.png` and confirm it shows the top bar with the round buttons, the "Version history" tooltip chip, and the `octocat` avatar. Re-run if the tooltip didn't render (bump the `waitForTimeout`).

- [ ] **Step 6: ROADMAP**

In `ROADMAP.md`, under "Google-Docs-style top bar & version history (2026-09-08)":
- Prefix the UI-1, UI-2, UI-4, UI-5 bullets with `**Shipped v1.54.0.**` (or convert them to a "Shipped" note like the CV2-5 entry's style).
- For UI-3: replace its body with a note — `**UI-3 — closed (2026-09-08).** VersionHistory.svelte already implements the listed gaps (Today/date labels, "(current)" marker, session grouping, per-group expand/collapse, author avatars +N). Any further polish is a small fix, tracked ad hoc.` — OR, if the fresh look during this work found a real gap, a one-line small-fix bullet describing it.
- Add this spec's Non-goals to the "Deferred considerations" section (per `feedback_roadmap_deferred_considerations`): JS-positioned tooltip primitive + real `aria-describedby` (→ accessibility pass); no server avatar field.

- [ ] **Step 7: TEST-COVERAGE**

Add rows to `docs/TEST-COVERAGE.md` in the relevant section (near the other UI / shell rows — search `SHELL-` or `CV2`):

```markdown
| UI-1 | `.icon-btn` base `border-radius: 50%` — top-bar (`#versionHistoryBtn`, `#settingsBtn`) and menu/sidebar icon buttons render circular; `.toolbar-overflow` menu rows keep their small radius | e2e-local | covered | `tests/e2e/local/topbar-chrome.spec.ts` | UI-1 |
| UI-5 | `[data-tooltip]::after` chip on `:hover` / `:focus-visible`; `client/index.html` top-bar buttons migrated `title=` → `data-tooltip=` (aria-label kept), `#shareBtn` drops its `title`; `#saveStatusBtn`'s runtime writes in `app.ts` moved to `data-tooltip` | unit + e2e-local | covered | `tests/client/src/topbar-tooltip.test.ts`, `tests/e2e/local/topbar-chrome.spec.ts` | UI-5 |
| UI-4 | `ModeSwitcher` renders no `.mode-switcher-label` when `modesAllowed.length >= 2` (icon + caret; mode-name `aria-label` + `data-tooltip`); keeps the label for a single-mode viewer | component | covered | `tests/client/src/components/ModeSwitcher.test.ts` | UI-4 |
| UI-2 | `TopbarAccount` — signed in: avatar `img` (`github.com/<user>.png`, `#icon-user` fallback on `error`) + a menu with the username and a Sign out item that `POST`s `/api/auth/github/logout`; signed out: a person-icon button → `openGithubSignInPopup`; e2e signed-out state in the top bar | component + e2e-local | covered | `tests/client/src/components/TopbarAccount.test.ts`, `tests/e2e/local/topbar-chrome.spec.ts` | UI-2 |
```

- [ ] **Step 8: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
npx playwright test --project=local
```
Expected: all green. (`webkit` needs its own browser — run `--project=local` explicitly and note `webkit` skipped if it can't be fetched, per `CLAUDE.md`.)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/topbar-chrome.png tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs ROADMAP.md docs/TEST-COVERAGE.md
git commit -m "$(cat <<'EOF'
chore: release 1.54.0 — top-bar chrome pass (UI-1/2/4/5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "Top-bar chrome pass (UI-1/2/4/5) — v1.54.0" --body "$(cat <<'EOF'
## What

The Google-Docs top-bar chrome cluster from the ROADMAP:

- **UI-1** — `.icon-btn` → circular, application-wide (overflow-menu rows excepted).
- **UI-5** — CSS-only `[data-tooltip]` hover/focus tooltip; top-bar buttons migrate `title=` → `data-tooltip=` (aria-label kept).
- **UI-4** — the mode switcher drops its label when there are 2+ modes to pick; a viewer keeps "Viewing".
- **UI-2** — a GitHub avatar + account menu (username / Sign out) as the last top-bar item; a person-icon sign-in button when signed out. No server changes.

**UI-3 dropped** — VersionHistory already has the listed features.

Spec: `docs/superpowers/specs/2026-09-08-topbar-chrome-design.md`
Plan: `docs/superpowers/plans/2026-09-08-topbar-chrome.md`

## Release

v1.54.0 — CHANGELOG + What's New entry (with screenshot) + TEST-COVERAGE rows (UI-1/2/4/5).

## Tests

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, and `npx playwright test --project=local` (incl. the new `topbar-chrome.spec.ts`) green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 11: Watch CI, merge on green** (after the user confirms) — `auto-tag.yml` tags `v1.54.0` → `release.yml` → Cloudflare auto-deploys.

---

## Self-Review

**1. Spec coverage:**
- UI-1 (circular buttons, walkback list, tests) → Task 1. ✅
- UI-4 (label gating, single-mode keeps label, pill not oval, existing e2e still passes) → Task 3. ✅ (existing `mode-switcher.spec.ts` viewer assertion covered — the viewer keeps the label; the editor test is migrated to match on `aria-label`, noted in Task 3 context.)
- UI-5 (`_tooltip.scss`, tokens light+dark, `:hover`+`:focus-visible`, reduced-motion, `title`→`data-tooltip`, keep `aria-label`, `#shareBtn` drops title, `#saveStatusBtn` runtime writes) → Task 2. ✅
- UI-2 (new component, mount, avatar + `.png` redirect, `onerror` fallback, menu with username + Sign out, signed-out person icon → popup, `#icon-user` sprite, `SignedOutIndicator` untouched) → Task 4. ✅
- UI-3 dropped + roadmap resolution → Task 5 Step 6. ✅
- Release (version, both lockfile fields, CHANGELOG, What's New + real screenshot, ROADMAP, TEST-COVERAGE, deferred-considerations copy) → Task 5. ✅
- Non-goal "no server changes" — honored (avatar via public redirect, logout endpoint already exists). ✅
- Non-goal "no new store" — honored (reuses `githubUsername`). ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The one conditional is Task 1 Step 5 / Task 5 Step 6 ("if the visual check finds an oval / a real UI-3 gap, add an override / a bullet") — these are genuine review gates with a stated expected outcome ("none needed" / "closed"), not deferred work. Acceptable.

**3. Type/name consistency:**
- `githubUsername` (`Writable<string|null>`) — used identically in Task 4 component + test.
- `window.MDE.openGithubSignInPopup` / `closeAllDropdowns` — match `types.ts:245-247`.
- `.topbar-account` / `.topbar-account-btn` / `.topbar-account-avatar` / `.topbar-account-menu` — consistent across Task 4's component, CSS (Step 7), and tests.
- `data-tooltip` attribute name — consistent across Tasks 2, 3, 4.
- `#topbar-account-mount` — consistent between `index.html` (Task 4 Step 4) and `main.ts` (Step 5).
- `#icon-user` — sprite added in Task 4 Step 4, referenced in the component (Step 3) and tests (Step 1).
- Mode-switcher: `.mode-switcher-label`, `LABELS`, `modesAllowed` — match the existing component.
- `capture-topbar-chrome-screenshot.mjs` output path `client/public/whats-new/topbar-chrome.png` matches the What's New entry's `screenshot` field.

No gaps found.
