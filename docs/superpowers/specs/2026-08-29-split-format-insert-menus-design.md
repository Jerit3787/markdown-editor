# Split Format and Insert Menus — Design Spec

**IMPROVEMENTS.md Phase 2 item:** "Split the Format and Insert menu concerns apart (currently combined)."

## Scope

Pure menu-bar reorganization, entirely within `client/src/components/MenuBar.svelte`. No new files, no behavior changes, no changes to `app.ts`, `types.ts`, or any store — every command, keyboard shortcut, icon, and `window.MDE` call stays exactly as it is today, just relocated into two new top-level dropdown menus.

## Goal

The current "Edit" menu mashes together three distinct concerns: real edit actions (Undo/Redo, Find/Find and Replace, Cut/Copy/Paste), text formatting (Bold/Italic/Strikethrough), and content insertion (Insert Link, Insert Image, Manage Images). Split the latter two out into their own top-level menus, so the menu bar reads File, **Edit**, **Format**, **Insert**, View, Help — matching the convention of grouping menu items by what they do, not leaving them all under Edit because that's where they historically landed.

## Non-goals (deferred)

- **No new buttons or commands.** This is a relocation, not a feature addition — confirmed explicitly during brainstorming.
- **No toolbar changes.** `Toolbar.svelte` has its own independent Bold/Italic/Link/Image buttons (verified: `formatCmd`/`menuBold`/etc. are referenced only inside `MenuBar.svelte`, nothing else depends on their current menu location) — untouched by this change.
- **No `ShortcutsModal.svelte` changes.** Its shortcut list is a flat list of label/key pairs with no menu-location grouping — verified by reading the file — so it needs no update.
- **No mobile-specific menu component.** There isn't one; `MenuBar.svelte` is the only menu bar, and the existing `@media (max-width: 780px)` rule in `_topbar.scss` already wraps the menu bar onto its own row rather than clipping or overflowing, so two additional top-level menus need no new responsive handling.

## Components

### `client/src/components/MenuBar.svelte` (modified only)

**New menu-button/menu-panel ref pairs**, declared alongside the existing four:

```ts
let formatMenuBtn: HTMLButtonElement, formatMenu: HTMLDivElement;
let insertMenuBtn: HTMLButtonElement, insertMenu: HTMLDivElement;
```

**`onMount`'s `pairs` array** gains two entries, in menu-bar order, so `toggleDropdown` and `enableMenuBarHoverSwitch` treat Format/Insert exactly like every other top-level menu (both functions are already generic over an arbitrary-length pairs array — confirmed by reading their `app.ts` implementations, no changes needed there):

```ts
const pairs = [
  { btn: fileMenuBtn, menu: fileMenu },
  { btn: editMenuBtn, menu: editMenu },
  { btn: formatMenuBtn, menu: formatMenu },
  { btn: insertMenuBtn, menu: insertMenu },
  { btn: viewMenuBtn, menu: viewMenu },
  { btn: helpMenuBtn, menu: helpMenu },
];
```

**Template changes**, in order:

1. The Edit menu (`#editMenu`) keeps only Undo, Redo, the Find/Find-and-Replace pair, and Cut/Copy/Paste — the two trailing groups (Bold/Italic/Strikethrough, and Insert Link/Insert Image/Manage Images) are removed from it, along with the two `<div class="menu-divider">` separators that only existed to separate those groups from the rest of Edit and from each other.
2. A new dropdown, `formatMenuBtn`/`formatMenu` (id `formatMenuBtn`/`formatMenu`), inserted immediately after the Edit dropdown's closing `</div>` and before the current View dropdown, containing exactly the three moved buttons verbatim — same `id`s (`menuBold`, `menuItalic`, `menuStrike`), same `onclick`/`disabled` bindings, same icons and `<kbd>` hints:

   ```svelte
   <button id="menuBold" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("bold"))}><b>B</b> Bold <kbd>Ctrl+B</kbd></button>
   <button id="menuItalic" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("italic"))}><i>I</i> Italic <kbd>Ctrl+I</kbd></button>
   <button id="menuStrike" type="button" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("strike"))}><svg class="icon"><use href="#icon-strikethrough"></use></svg> Strikethrough</button>
   ```

3. A new dropdown, `insertMenuBtn`/`insertMenu` (id `insertMenuBtn`/`insertMenu`), inserted immediately after the new Format dropdown's closing `</div>` and before the View dropdown, containing exactly the three moved buttons verbatim — same `id`s (`menuLink`, `menuImage`, `menuManageImages`):

   ```svelte
   <button id="menuLink" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("link"))}><svg class="icon"><use href="#icon-link"></use></svg> Insert Link... <kbd>Ctrl+K</kbd></button>
   <button id="menuImage" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("image"))}><svg class="icon"><use href="#icon-image"></use></svg> Insert Image...</button>
   <button id="menuManageImages" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.openImagesManager())}><svg class="icon"><use href="#icon-images"></use></svg> Manage Images...</button>
   ```

4. Two new top-level `<button class="menubar-btn" type="button">Format</button>` / `...>Insert</button>` triggers, positioned between the existing Edit and View triggers in the top-level nav markup, following the exact same `<div class="dropdown">` wrapper structure File/Edit/View/Help already use.

No new CSS is needed — `.dropdown`, `.menubar-btn`, `.dropdown-menu.menubar-menu`, `.menu-divider`, and `.menu-glyph-btn` are all existing, reused classes.

## Testing

- New Playwright e2e test (`tests/e2e/local/`) verifying: the Format menu opens and clicking Bold/Italic/Strikethrough still applies formatting to selected text; the Insert menu opens and clicking Insert Link still runs the link command; the Edit menu no longer contains a Bold/Insert Link button (regression guard against the split silently not happening, or being applied to the wrong menu).
- No existing test references `#editMenu`'s contents or these button ids in a way that assumes their current container (verified via search) — no other test file needs updating.

## Versioning

This is a UI reorganization visible to every user opening the menu bar, so it's user-facing: minor version bump, `CHANGELOG.md` entry, and a `whats-new-entries.ts` entry with a real screenshot, per this repo's versioning convention.
