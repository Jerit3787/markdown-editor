# Editor Core Migration Design (Phase D)

## Context

Phases A-C (see the three prior specs in this directory) moved the
CodeMirror compartments/keybindings/focus-mode, the four editor-feature
`StateField`s, and the preview render pipeline out of `client/src/app.ts`.
`app.ts` is now 1290 lines, down from the original 2343.

This is Phase D of the seven-phase plan. The original roadmap grouped
"toolbar & doc title" together; this spec narrows that to just formatting
commands and view toggle — doc-title's rename flow calls `scheduleSave()`,
which is Phase E's ("save status") and not yet moved, so including it here
would mean bridging into still-app.ts-owned code for a feature that fits
more naturally alongside Phase E's own save-status work. This mirrors how
Phase A itself was narrowed down from the original roadmap's larger first
cut.

Same hard constraint as Phases A-C: everything becomes genuinely Svelte
(or, where there's no template/UI of its own, a plain reactive module —
same treatment `editor-theme.ts`/`escape-html.ts` already got for
zero-coupling pure logic).

## Goals

- New `client/src/formatting-commands.ts`: `runCmd`, `wrapSelection`,
  `prefixLine`, `insertLink`, `insertLinkIntoEditor`, `insertImage`,
  `insertTable`, `insertBlock`, `insertMathSnippet`,
  `insertFootnoteSnippet` move here verbatim (`cm` → `window.MDE.getEditor()`).
  This is a **plain module, not a Svelte component** — none of these
  functions touch the DOM beyond `window.MDE.getEditor()` and two modal
  stores (`linkModalOpen`/`linkModalPrefillText`), so there's nothing a
  component's template/lifecycle would add. Follows the exact precedent
  `client/src/gist.ts`/`client/src/repo-sync-ui.ts` already established:
  a plain module, imported directly in `main.ts` (not via a component's
  `onMount`), assigning its own `window.MDE.*` bridge methods at module
  top-level.
- `window.MDE.runCmd`, `insertLinkIntoEditor`, and `insertAtCursor`
  (currently a thin `(text) => insertBlock(text)` wrapper in app.ts's
  bridge literal — `insertBlock` is a hidden second caller of this move,
  found via the same call-site audit every prior phase has done) all flip
  from required to optional, assigned by `formatting-commands.ts` at
  module load — same doc-comment convention `publishGist?` already uses
  ("optional because app.ts's own bridge literal is typed/assigned before
  this module's code runs"), not the "assigned by X.svelte's onMount"
  wording used for Phases A-C's component-owned methods.
- `Toolbar.svelte`'s own `run(cmd)` wrapper (currently
  `window.MDE.runCmd(cmd)`) switches to importing `runCmd` directly from
  `../formatting-commands` — it's a plain function in a plain module now,
  so Toolbar's own buttons don't need the bridge round-trip. External
  callers (`CommandPalette.svelte`, `SlashMenu.svelte`, `MenuBar.svelte`)
  keep calling `window.MDE.runCmd(...)` unchanged — they still need the
  bridge, since components can't import from each other.
- `app.ts`'s own `buildEditorExtensions()` Mod-b/Mod-i/Mod-k keymap
  (`wrapSelection(...)`/`insertLink()`) imports both directly from
  `./formatting-commands` — a plain-module-to-plain-module import, no
  bridge needed for this direction at all.
- `stores/view.ts` absorbs `setView`, `STORAGE_VIEW`, and
  `initViewToggle`'s init-on-load behavior — becoming the **sole owner**
  of view-mode state and its `localStorage`/`#body`-className side
  effects, the same full-ownership treatment Phase A's
  `stores/keybindings.ts` already got for keybinding mode.
  `window.MDE.setView` is **eliminated outright** (not left optional) —
  confirmed via grep that every caller can reach the store directly:
  `stores/view.ts`'s own `toggleEditorPane`/`togglePreviewPane` call the
  now-local `setView`; `CommandPalette.svelte` (the only external
  `window.MDE.setView` caller) imports `setView` from `../stores/view`
  instead.
- `client/src/stores/view.test.ts` (a real, existing test file — the
  first time this migration has needed to touch one) gets rewritten:
  it currently mocks `window.MDE.setView` and asserts on the mock's call
  arguments; since `setView` is no longer bridged, the rewrite asserts on
  `viewMode`'s resulting store value directly instead — a more direct,
  implementation-detail-free test of the same behavior
  (`toggleEditorPane`/`togglePreviewPane`'s no-op/toggle logic), not a
  weaker one.
- No behavior change to anything user-facing. Every formatting command,
  the Mod-b/Mod-i/Mod-k shortcuts, the view-mode toggle (buttons, Command
  Palette entries, and its `localStorage` persistence across reloads)
  must work identically after this phase.

## Non-goals

- Doc-title (`#docTitle`/`#docTitleMirror`, `initToolbar()`'s
  input/focus/blur/keydown handlers, `resizeDocTitle`, the
  doc-title-input-triggered half of `updatePageTitle`) — deferred to
  Phase E, per this spec's Context section. `updatePageTitle` itself
  (still called from `loadDocIntoEditor()` on every doc switch) is
  untouched — that caller isn't part of doc-title *editing*, it's part of
  doc *loading*, which stays app.ts's regardless of which phase doc-title
  editing eventually lands in.
- `scheduleSave`, sidebar toggle — Phase E's, per the original roadmap.
  Untouched.
- Any UI/visual change. Structural move only.

## Architecture

### New: `client/src/formatting-commands.ts`

```typescript
import { linkModalOpen, linkModalPrefillText } from "./stores/linkModal";

export function runCmd(cmd: string) {
  switch (cmd) {
    case "bold": return wrapSelection("**", "**", "bold text");
    case "italic": return wrapSelection("_", "_", "italic text");
    case "strike": return wrapSelection("~~", "~~", "strikethrough");
    case "h1": return prefixLine("# ");
    case "h2": return prefixLine("## ");
    case "h3": return prefixLine("### ");
    case "quote": return prefixLine("> ");
    case "code": return wrapSelection("`", "`", "code");
    case "codeblock": return wrapSelection("```\n", "\n```", "code");
    case "ul": return prefixLine("- ");
    case "ol": return prefixLine("1. ");
    case "task": return prefixLine("- [ ] ");
    case "link": return insertLink();
    case "image": return insertImage();
    case "table": return insertTable();
    case "hr": return insertBlock("\n---\n");
    case "math": return insertMathSnippet();
    case "footnote": return insertFootnoteSnippet();
  }
}

export function wrapSelection(before: string, after: string, placeholder?: string) {
  const view = window.MDE.getEditor();
  const { from, to } = view.state.selection.main;
  // ...verbatim, cm -> view...
}

export function prefixLine(prefix: string) {
  // ...verbatim...
}

export function insertLink() {
  const view = window.MDE.getEditor();
  const { from, to } = view.state.selection.main;
  linkModalPrefillText.set(view.state.sliceDoc(from, to));
  linkModalOpen.set(true);
}

export function insertLinkIntoEditor(text: string, url: string) {
  // ...verbatim...
}

export function insertImage() {
  document.getElementById("imageFileInput").click();
}

export function insertTable() {
  insertBlock(/* ...verbatim table markdown... */);
}

export function insertBlock(block: string) {
  // ...verbatim...
}

export function insertMathSnippet() {
  // ...verbatim...
}

export function insertFootnoteSnippet() {
  // ...verbatim...
}

// MenuBar.svelte/CommandPalette.svelte/SlashMenu.svelte call these
// directly (window.MDE.runCmd/insertAtCursor) — they have no access to
// this module's functions otherwise, same reasoning as every other
// window.MDE bridge method. Toolbar.svelte imports runCmd directly
// instead (see Toolbar.svelte's own change below) since it's a plain
// function in a plain module, not a component-owned one.
window.MDE.runCmd = runCmd;
window.MDE.insertLinkIntoEditor = insertLinkIntoEditor;
window.MDE.insertAtCursor = insertBlock;
```

### `main.ts` change

Add `import "./formatting-commands";` alongside the other plain-module
imports at the top (`import "./app"; import "./collab"; import "./gist";
import "./repo-sync-ui";`) — same import-order reasoning already
documented there (app.ts sets up `window.MDE` first; these assign onto
it after).

### `Toolbar.svelte` change

```svelte
  import { runCmd } from "../formatting-commands";

  function run(cmd: string) {
    runCmd(cmd);
    window.MDE.getEditor().focus();
  }
```

(was `window.MDE.runCmd(cmd);` — everything else in the component is
unchanged.)

### `app.ts`'s Mod-b/Mod-i/Mod-k keymap

```typescript
import { wrapSelection, insertLink } from "./formatting-commands";
// ...
keymap.of([
  { key: "Mod-b", run: () => { wrapSelection("**", "**", "bold text"); return true; } },
  { key: "Mod-i", run: () => { wrapSelection("_", "_", "italic text"); return true; } },
  { key: "Mod-k", run: () => { insertLink(); return true; } },
]),
```

(Same call shape as today — only the import source changes, from local
closure functions to an imported plain module.)

### `stores/view.ts` — target shape

```typescript
import { writable, get } from "svelte/store";

export type ViewMode = "editor" | "split" | "preview";

const STORAGE_VIEW = "mde:view";

function loadViewMode(): ViewMode {
  const raw = localStorage.getItem(STORAGE_VIEW);
  return raw === "editor" || raw === "preview" ? raw : "split";
}

export const viewMode = writable<ViewMode>(loadViewMode());

export function isEditorOn(mode: ViewMode): boolean {
  return mode !== "preview";
}
export function isPreviewOn(mode: ViewMode): boolean {
  return mode !== "editor";
}

export function setView(view: ViewMode): void {
  document.getElementById("body")!.className = `mode-${view}`;
  localStorage.setItem(STORAGE_VIEW, view);
  viewMode.set(view);
}

// Applies the loaded mode's #body class on module load — mirrors
// app.ts's old initViewToggle(), now self-contained here instead of
// being kicked off from its DOMContentLoaded-gated init(). #body
// already exists by module-load time (a plain div early in index.html,
// well before any <script type="module"> tag) — same guarantee
// docsStore's/keybindingMode's own self-init already relies on.
document.getElementById("body")!.className = `mode-${get(viewMode)}`;

export function toggleEditorPane(): void {
  const mode = get(viewMode);
  if (isEditorOn(mode) && !isPreviewOn(mode)) return;
  setView(isEditorOn(mode) ? "preview" : "split");
}
export function togglePreviewPane(): void {
  const mode = get(viewMode);
  if (isPreviewOn(mode) && !isEditorOn(mode)) return;
  setView(isPreviewOn(mode) ? "editor" : "split");
}
```

(`toggleEditorPane`/`togglePreviewPane` change only their inner call —
`window.MDE.setView(...)` → local `setView(...)` — everything else,
including their own exported signatures, is unchanged, so no caller of
*them* needs updating.)

### `CommandPalette.svelte` change

```svelte
  import { setView } from "../stores/view";
  // ...
  { id: "view-editor", label: "Switch to Editor view", category: "View", run: () => setView("editor") },
  { id: "view-split", label: "Switch to Split view", category: "View", run: () => setView("split") },
  { id: "view-preview", label: "Switch to Preview view", category: "View", run: () => setView("preview") },
```

### `client/src/types.ts` (`MDEBridge`) changes

- `setView(mode: ...): void;` — removed entirely (no `?`, fully gone —
  matches how Phase A fully removed `setKeybindings` once nothing needed
  the bridge indirection).
- `runCmd(cmd: string): void;`, `insertLinkIntoEditor(text: string, url: string): void;`,
  `insertAtCursor(text: string): void;` — all three move from required to
  optional, with the `publishGist?`-style doc comment (module-assigned,
  not component-assigned).

### `client/src/stores/view.test.ts` changes

The `toggleEditorPane`/`togglePreviewPane` describe block currently mocks
`window.MDE.setView` and asserts on the mock. Rewritten to assert on
`viewMode`'s resulting value instead:

```typescript
describe("toggleEditorPane / togglePreviewPane", () => {
  it("toggleEditorPane from split turns editor off (-> preview)", () => {
    viewMode.set("split");
    toggleEditorPane();
    expect(get(viewMode)).toBe("preview");
  });
  // ...five more, same shape, mirroring the existing six cases exactly —
  // same inputs/expected outcomes, just asserting the store's value
  // instead of a bridge-call mock.
});
```

(`document.getElementById("body")` also needs to exist in this test's
jsdom environment for `setView`'s className write not to throw — the
file already declares `// @vitest-environment jsdom` at its top, but the
rewritten tests need a `<div id="body">` present; the implementation plan
adds a `beforeEach` that ensures one exists, since the module-load-time
`setView` call in `stores/view.ts` will also run once when the test file
first imports it, before any per-test DOM setup — see the plan's own
task for the exact resolution.)

### `app.ts` changes

- `runCmd`, `wrapSelection`, `prefixLine`, `insertLink`,
  `insertLinkIntoEditor`, `insertImage`, `insertTable`, `insertBlock`,
  `insertMathSnippet`, `insertFootnoteSnippet` — deleted (moved
  verbatim).
- `setView`, `initViewToggle`, `STORAGE_VIEW` — deleted (moved,
  `STORAGE_VIEW` folded into `stores/view.ts`'s own module scope).
- `init()`'s `initViewToggle();` call — deleted (replaced by
  `stores/view.ts`'s own module-load-time application).
- The bridge literal's `runCmd,`, `insertAtCursor: (text: string) => insertBlock(text),`,
  `insertLinkIntoEditor,`, and `setView,` entries — all four removed
  (matches how every prior phase fully removed its own moved bridge
  methods from this literal rather than leaving stubs).
- Mod-b/Mod-i/Mod-k keymap — imports `wrapSelection`/`insertLink` from
  `./formatting-commands` instead of calling local closure functions.

## Data flow

```
User presses Mod-B (or clicks Toolbar's Bold button, or runs it from
Command Palette/slash menu)
  │
  ├─ Mod-B: app.ts's buildEditorExtensions() keymap calls
  │  formatting-commands.ts's wrapSelection() directly (plain import)
  │
  ├─ Toolbar button: Toolbar.svelte calls formatting-commands.ts's
  │  runCmd() directly (plain import)
  │
  └─ Command Palette / slash menu: window.MDE.runCmd() (bridge — these
     components can't import formatting-commands.ts's functions any
     other way)
  │
  ▼
formatting-commands.ts's wrapSelection()/runCmd() dispatches against
window.MDE.getEditor()

---

User clicks Toolbar's editor/preview-pane toggle (or MenuBar's View
menu, or Command Palette's view-mode entries)
  │
  ▼
stores/view.ts's toggleEditorPane()/togglePreviewPane(), or
CommandPalette's direct setView("editor"|"split"|"preview") import
  │
  ▼
stores/view.ts's local setView(): #body className + localStorage +
viewMode.set(...) — all three side effects now owned in one place
  │
  ▼
Toolbar.svelte's/MenuBar.svelte's $derived(isEditorOn($viewMode)) etc.
react automatically (unchanged — they already read the store, not the
bridge)
```

## Error handling

- No new failure modes — every dispatch/render path already exists
  today; this phase relocates who owns it.
- `formatting-commands.ts`'s three now-optional bridge methods carry the
  same "optional because assigned after app.ts's own bridge literal, but
  before anything could actually call them" reasoning `publishGist?`
  already documents — `main.ts` imports `"./formatting-commands"` as one
  of its very first lines (alongside `gist`/`repo-sync-ui`), long before
  any user interaction is possible.
- `setView`'s full removal from the bridge (not left optional) means a
  stale reference to `window.MDE.setView` would now be a hard
  `TypeError: window.MDE.setView is not a function` instead of silently
  doing nothing — confirmed via this spec's own grep that no such stale
  reference exists after `CommandPalette.svelte`'s update.

## Testing

Same posture as Phases A-C for the *new* moved code (no unit-test
precedent for this kind of DOM/CodeMirror-dispatch logic) — verified via
live-browser technique. The one exception is `stores/view.test.ts`,
which already has real unit-test coverage and gets rewritten (not
dropped) to keep testing the same `toggleEditorPane`/`togglePreviewPane`
behavior through its new, more direct assertion shape.

Live-verification covers:
- Every `runCmd` case (bold/italic/strike/h1-h3/quote/code/codeblock/
  ul/ol/task/link/image/table/hr/math/footnote) via Toolbar buttons.
- Mod-b/Mod-i/Mod-k keyboard shortcuts.
- The same set of commands via Command Palette and the slash-command
  menu (both already bridge-mediated, unchanged call shape, but worth
  confirming the newly-optional bridge methods are actually assigned in
  time).
- View-mode toggling via Toolbar's pane buttons, MenuBar's View menu,
  and Command Palette's three view entries — confirm `#body`'s class,
  `localStorage`'s `mde:view` key, and a reload correctly restoring the
  persisted mode.
- `DiagramEditor.svelte`'s diagram-insert flow (exercises
  `window.MDE.insertAtCursor`).
- Regression spot-check on Phases A-C's own live-verification (cheap
  given the shared dev-server setup).

## Self-review

- **Placeholder scan**: none — every moved function and bridge change is
  concrete; verbatim-move sections point at their exact current app.ts
  location.
- **Internal consistency**: the Non-goals list (doc-title, save/sidebar)
  matches exactly what stays in app.ts per the Architecture section.
  `insertAtCursor`'s hidden coupling to `insertBlock` — found via this
  spec's own call-site audit, the same discipline that caught Phase B's
  `setCommentMarkers` gap and Phase C's `updatePreview` gap — is resolved
  explicitly (moves with `insertBlock`, bridge-assigned as
  `window.MDE.insertAtCursor = insertBlock`) rather than left for the
  plan to rediscover.
- **Scope check**: one new plain module, one store gaining full
  ownership (mirroring Phase A's `stores/keybindings.ts` precedent
  exactly), four bridge-method changes (three flipped optional, one
  removed outright), one existing test file rewritten. Smaller than
  Phases B/C, consistent with this phase's narrower (doc-title deferred)
  scope.
- **Ambiguity check**: the doc-title scope question was resolved
  explicitly via user decision (deferred to Phase E) rather than left
  ambiguous. The `view.test.ts` rewrite's one wrinkle — `setView`'s
  module-load-time `#body` access needing a DOM element present before
  the test file's own `beforeEach` blocks run — is flagged explicitly
  here for the implementation plan to resolve concretely, not glossed
  over.
