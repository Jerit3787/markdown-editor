# Editor Core Migration Design (Phase A)

## Context

`client/src/app.ts` is 2,343 lines — the last major holdout of the app's
pre-Svelte era. Most standalone UI (modals, sidebar doc list, menu bar,
editor pane host, formatting toolbar) was already converted to Svelte
components across an earlier, informally-tracked migration (see git log:
"Phase 1" through "Phase 6", then a run of "refactor: convert X to Svelte"
commits). That effort stalled before touching app.ts's own core: the
CodeMirror extension wiring, save/preview pipeline, and the `window.MDE`
bridge tying everything together.

This is the first of a seven-phase plan to finish it, each phase its own
spec + implementation plan, merged and live-verified independently — no
big-bang rewrite:

- **Phase A** (this spec): the editor-extension compartments (readOnly,
  editing-mode, focus-mode, keybindings), keybinding-mode switching, and
  focus mode itself, all absorbed into `Editor.svelte`.
- **Phase B**: the remaining editor-feature extensions — comment markers,
  image markers, slash commands, wikilink autocomplete. Deliberately cut
  from Phase A: each is its own self-contained `StateField`, not coupled
  to the compartment plumbing, and Phase A was already dense enough on
  its own.
- **Phase C**: the preview pane — new `Preview.svelte` (markdown render
  pipeline, sync-scroll, wikilink navigation-in-preview).
- **Phase D**: toolbar & doc title — formatting commands, view toggle,
  doc-title input absorbed into existing `Toolbar.svelte`/`MenuBar.svelte`.
- **Phase E**: save status & sidebar toggle — new `SaveStatus.svelte`;
  sidebar toggle logic into `DocList.svelte`.
- **Phase F**: import/export; audit whether the vanilla dropdown/submenu
  machinery (`closeAllDropdowns`, `toggleDropdown`,
  `enableMenuBarHoverSwitch`, `initSubmenus`, `closeSubmenus`) is dead
  code now that `MenuBar.svelte` exists.
- **Phase G**: cleanup — shrink `window.MDE` (`MDEBridge`, `client/src/types.ts`)
  to whatever `collab.ts`/`gist.ts`/`repo-sync-ui.ts` genuinely still need
  cross-module once every phase above has landed; confirm `app.ts` is down
  to bootstrapping only.

The user has set one hard constraint for the whole plan: **everything
becomes genuinely Svelte**, including logic with no template of its own
(e.g. CodeMirror extension wiring) — driven by `$effect`, not left as a
plain `.ts` module that merely relocates the same imperative style.
`DiagramEditor.svelte` (an existing component that already owns a second,
independent `EditorView` instance) is the precedent this spec follows
throughout.

## Goals

- The four compartments this phase owns (`readOnlyCompartment`,
  `editingModeCompartment`, `focusModeCompartment`, `keybindingsCompartment`),
  `localEditingModeExtensions()`, and `collabUndoManager` move from
  app.ts's closure into `Editor.svelte`'s own `<script>` scope.
- Keybinding-mode switching (normal/vim/emacs) becomes a real store
  (`client/src/stores/keybindings.ts`, new) that owns its own
  `localStorage` persistence — `Settings.svelte` writes to it directly
  instead of calling `window.MDE.setKeybindings()`; `Editor.svelte` reacts
  to it via `$effect`.
- Focus mode's existing store (`client/src/stores/focusMode.ts`) becomes
  the single source of truth for the *compartment* too, not just the UI
  toggle state it already drives — `Editor.svelte` reacts to it via
  `$effect` instead of `window.MDE.toggleFocusMode()` imperatively
  dispatching a reconfigure.
- `editorTheme` and `markdownHighlightStyle` — pure, zero-coupling
  values — move into a new `client/src/editor-theme.ts` module. Trivial,
  low-risk, and no reason to route them through a bridge at all.
- `setReadOnly`, `enterCollabMode`, `exitCollabMode`, `undo`, `redo` move
  from app.ts's bridge-object literal to being assigned by `Editor.svelte`
  onto the already-existing `window.MDE` object at mount time — same
  established pattern `gist.ts`/`repo-sync-ui.ts` already use for their
  own bridge contributions (`window.MDE.publishGist = publish;` etc.).
- No behavior change. Every one of the following must work identically
  after this phase: normal/vim/emacs keybindings (including the runtime
  switch and the status-bar mode indicator), focus mode (including the
  mobile exit button and typewriter-scroll), collab read-only/editing-mode
  switching when a shared room is joined/left, and undo/redo routing
  between the local and collaborative undo stacks.

## Non-goals

- Comment markers, image markers, slash commands, wikilink autocomplete —
  Phase B. `buildEditorExtensions()`'s returned array still includes
  these (see Architecture below for exactly how) — Phase A does not touch
  their implementation, only continues sourcing them from app.ts for now.
- Formatting keymaps (`Mod-b`/`Mod-i`/`Mod-k`), `wrapSelection`,
  `insertLink` — Phase D (toolbar/formatting commands). Same treatment:
  still sourced from app.ts, untouched otherwise.
- `scheduleSave`, `updatePreview`, `updateCounts`, `followCursorInPreview`,
  `activeDocContent` — Phase C/E territory. Still sourced from app.ts.
- Image paste/drop handling (`imageFilesFrom`, `insertImageWithUpload`) —
  Phase B.
- Shrinking `MDEBridge` beyond the five functions this phase's own state
  relocation forces to move. `getEditorExtensions()` stays on the bridge
  (its *contract* changes — see Architecture — but the method itself
  isn't removed until Phase G, once nothing external remains to source).
- Any UI/visual change. This is a structural move, not a redesign.

## Architecture

### New: `client/src/stores/keybindings.ts`

Self-contained, owns its own persistence — same shape as
`client/src/stores/workspaces.ts`'s relationship to its own `localStorage`
keys, not `stores/view.ts`'s (which leaves persistence to app.ts). This is
the one piece of Phase A that's a genuine behavior owner change, not just
a relocation: today `app.ts` reads/writes `mde:keybindings` directly, and
`Settings.svelte` *duplicates* the same key as a local `$state` read
(`client/src/components/Settings.svelte:9,14`) — a two-owners-for-one-value
situation this phase fixes by giving it exactly one owner.

```typescript
import { writable } from "svelte/store";

export type KeybindingMode = "normal" | "vim" | "emacs";

const STORAGE_KEYBINDINGS = "mde:keybindings";

function loadKeybindingMode(): KeybindingMode {
  const raw = localStorage.getItem(STORAGE_KEYBINDINGS);
  return raw === "vim" || raw === "emacs" ? raw : "normal";
}

export const keybindingMode = writable<KeybindingMode>(loadKeybindingMode());

export function setKeybindingMode(mode: KeybindingMode): void {
  localStorage.setItem(STORAGE_KEYBINDINGS, mode);
  keybindingMode.set(mode);
}
```

`Settings.svelte`'s keybinding buttons call `setKeybindingMode(mode)`
directly (imported from the store) instead of
`window.MDE.setKeybindings(mode)` — `MDEBridge.setKeybindings` is removed
from the interface entirely (not deferred to Phase G, since nothing else
calls it: confirmed via `grep -rn "MDE.setKeybindings"` — `Settings.svelte`
is the only caller).

### `Editor.svelte` — target shape

The compartments, `collabUndoManager`, and `localEditingModeExtensions()`
become plain instance-scoped variables in the component's `<script>` —
not `$state` (same reasoning `DiagramEditor.svelte`'s own `codeView`
already establishes: an opaque CodeMirror/library instance that's never
read from a Svelte template doesn't need Svelte's own change-tracking on
top of the library's own).

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView, keymap, drawSelection } from "@codemirror/view";
  import { EditorState, Compartment, type Extension } from "@codemirror/state";
  import { history, historyKeymap, undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
  import { keybindingMode, type KeybindingMode } from "../stores/keybindings";
  import { focusMode } from "../stores/focusMode";
  import { activeParagraphRange } from "../focus-mode";
  import { Decoration, StateField, type DecorationSet } from "@codemirror/view";

  let hostEl: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;

  const readOnlyCompartment = new Compartment();
  const editingModeCompartment = new Compartment();
  const focusModeCompartment = new Compartment();
  const keybindingsCompartment = new Compartment();

  interface UndoManagerLike {
    undo(): void;
    redo(): void;
  }
  let collabUndoManager: UndoManagerLike | null = null;

  function localEditingModeExtensions(): Extension {
    return [history(), keymap.of(historyKeymap)];
  }

  // ...dimLineMark/computeDimDecorations/focusDimField/centerCursorLine/
  // typewriterListener/focusModeExtensions: moved verbatim from app.ts,
  // no logic changes — see Non-goals for what's explicitly NOT moving.

  // ...keybindingsExtensionsFor(mode): moved verbatim (the dynamic
  // import()-based vim/emacs lazy-loading from this session's earlier
  // bundle-size fix is unchanged).

  async function applyKeybindingMode(mode: KeybindingMode): Promise<void> {
    if (!view) return;
    const extensions = await keybindingsExtensionsFor(mode);
    view.dispatch({ effects: keybindingsCompartment.reconfigure(extensions) });
    await updateKeybindingIndicator(mode); // moved verbatim from app.ts
  }

  // Reactive replacements for setKeybindings()/toggleFocusMode()'s old
  // imperative dispatch calls — this is the actual $effect-driven part
  // the user asked for. $effect re-runs whenever the store value
  // changes, whether that's Settings.svelte's runtime switch or the
  // initial value read at mount.
  $effect(() => {
    if (view) void applyKeybindingMode($keybindingMode);
  });

  $effect(() => {
    if (!view) return;
    document.body.classList.toggle("focus-mode", $focusMode);
    view.dispatch({ effects: focusModeCompartment.reconfigure($focusMode ? focusModeExtensions() : []) });
    if ($focusMode) centerCursorLine(view);
  });

  function buildExtensions(): Extension[] {
    return [
      keybindingsCompartment.of([]),
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      editingModeCompartment.of(localEditingModeExtensions()),
      focusModeCompartment.of([]),
      drawSelection(),
      // Everything Phase B/C/D still own — see "Bridging what hasn't
      // moved yet" below.
      ...window.MDE.getEditorExtensions(),
    ];
  }

  onMount(() => {
    view = new EditorView({ doc: "", parent: hostEl, extensions: buildExtensions() });
    window.MDE.registerEditor(view);

    // Bridge contributions this phase now owns — same established
    // pattern gist.ts/repo-sync-ui.ts already use for their own optional
    // bridge methods (window.MDE.publishGist = publish; etc.), not a new
    // mechanism. Safe timing-wise: Editor.svelte's onMount already runs
    // before app.ts's DOMContentLoaded-triggered init() (existing
    // guarantee app.ts's own comments document), and collab.ts can only
    // call these after a room is joined, which needs user interaction
    // that can't happen before mount completes.
    window.MDE.undo = () => {
      if (collabUndoManager) collabUndoManager.undo();
      else cmUndo(view!);
      view!.focus();
    };
    window.MDE.redo = () => {
      if (collabUndoManager) collabUndoManager.redo();
      else cmRedo(view!);
      view!.focus();
    };
    window.MDE.setReadOnly = (readOnly) => {
      view!.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
    };
    window.MDE.enterCollabMode = (extensions, undoManager) => {
      collabUndoManager = undoManager;
      view!.dispatch({ effects: editingModeCompartment.reconfigure(extensions) });
    };
    window.MDE.exitCollabMode = () => {
      collabUndoManager = null;
      view!.dispatch({ effects: editingModeCompartment.reconfigure(localEditingModeExtensions()) });
    };
  });

  onDestroy(() => {
    view?.destroy();
  });
</script>

<div id="editorWrap">
  <div bind:this={hostEl} class="cm-host"></div>
</div>
```

### Bridging what hasn't moved yet

`buildEditorExtensions()` today returns one flat array mixing this
phase's compartments with formatting keymaps, the markdown language,
syntax highlighting, image/slash/wikilink/comment fields, the main
`updateListener` (save/preview/counts), and paste/drop handlers — all
still app.ts-owned. Phase A can't extract its own four compartments
without app.ts keeping the ability to hand over everything else, so
`MDEBridge.getEditorExtensions()` **stays**, but its contract changes:
today it returns the *entire* extension list; after this phase, it
returns only the part `Editor.svelte` doesn't yet own. App.ts's own
`buildEditorExtensions()` shrinks to exactly that remainder — every line
Phase A doesn't touch — and its doc comment gets updated to say so
explicitly. This call disappears entirely once Phase D (the last phase
still contributing to it) lands; removing it is Phase G's job, not this
one's.

### `client/src/types.ts` (`MDEBridge`) changes

- Removed: `setKeybindings(mode)` — no longer needed, see the store
  section above.
- Moved from required to optional (`?`), matching the existing
  `publishGist?`/`openGistPicker?`/`openRepoLinkModal?` precedent exactly,
  with the same doc-comment convention explaining why: `undo`, `redo`,
  `setReadOnly`, `enterCollabMode`, `exitCollabMode`. `Editor.svelte`
  fills these in at mount, same as gist.ts/repo-sync-ui.ts already do for
  their own contributions.
- `toggleFocusMode()`: removed. Its three call sites
  (`CommandPalette.svelte:104`, `MenuBar.svelte:227`, and app.ts's mobile
  `focusModeExitBtn` listener) each become a direct
  `focusMode.update((v) => !v)` (the mobile exit button, which only ever
  turns focus mode *off*, becomes `focusMode.set(false)`), removing the
  bridge indirection entirely rather than deferring it to Phase G — same
  reasoning as `setKeybindings`: nothing else needs it once Phase A ships.
- `getEditorExtensions()`: kept, contract updated per the section above
  (doc comment rewritten, no signature change).

### `client/src/editor-theme.ts` (new)

```typescript
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({ /* moved verbatim from app.ts:337 */ });
export const markdownHighlightStyle = HighlightStyle.define([ /* moved verbatim from app.ts:358 */ ]);
```

`Editor.svelte` imports both directly; app.ts's `buildEditorExtensions()`
remainder no longer references either (they move fully out, unlike the
Phase B/C/D-owned pieces which stay referenced from app.ts for now) —
they have zero coupling to anything else in app.ts's closure, so there's
no reason to bridge them through `getEditorExtensions()` at all.

## Data flow

```
Settings.svelte: click "Vim"
  │
  ▼
setKeybindingMode("vim") — writes localStorage + keybindingMode store
  │
  ▼
Editor.svelte's $effect (watching $keybindingMode) fires
  │
  ▼
applyKeybindingMode("vim") — dynamic import()s @replit/codemirror-vim,
  reconfigures keybindingsCompartment, updates the status-bar indicator

---

collab.ts: joining a shared room
  │
  ▼
window.MDE.enterCollabMode(yCollabExtensions, undoManager)
  (function value now supplied by Editor.svelte's onMount, not app.ts)
  │
  ▼
editingModeCompartment.reconfigure(yCollabExtensions);
collabUndoManager = undoManager  (both now Editor.svelte-local state)

---

MenuBar.svelte: View > Focus Mode
  │
  ▼
focusMode.update(v => !v)
  │
  ▼
Editor.svelte's $effect (watching $focusMode) fires
  │
  ▼
focusModeCompartment.reconfigure(...) + centerCursorLine if turning on
```

## Error handling

- No new failure modes — every reconfigure path already exists today;
  this phase relocates who calls `.dispatch()`, not what's dispatched.
- `applyKeybindingMode`'s dynamic `import()` failure handling is
  unchanged from the existing (already-shipped, this session)
  lazy-loading behavior — not revisited here.
- `window.MDE.undo`/`redo`/`setReadOnly`/`enterCollabMode`/`exitCollabMode`
  being optional now means a caller reaching them before `Editor.svelte`'s
  `onMount` runs would hit `undefined()`. This is not a new risk in
  practice — `MenuBar.svelte` (undo/redo) and `collab.ts`
  (setReadOnly/enterCollabMode/exitCollabMode) can only be reached after
  the app has fully loaded and a user has taken an action — but it's
  worth a one-line comment at each new optional field, same as the
  existing `publishGist?` precedent already carries.

## Testing

No new unit tests — this codebase has zero precedent for testing Svelte
component internals (`find client/src/components -name "*.test.ts"`
returns nothing) or CodeMirror extension construction directly (none of
the existing compartment/extension code is unit-tested today either).
Verified instead via this session's established live-browser technique
(dev server + Chrome automation with seeded `localStorage`):

- Normal mode (default): editor accepts plain typing, no vim/emacs status
  indicator shown.
- Vim mode: switch via Settings, confirm the status bar shows the vim
  mode indicator, and a real vim motion (`0dw` or similar) behaves
  correctly — not just that the indicator changed.
- Emacs mode: switch via Settings, confirm the indicator shows "EMACS".
- Focus mode: toggle via `MenuBar.svelte`'s View menu and via
  `CommandPalette.svelte`, confirm the current paragraph stays undimmed
  and the rest of the document dims; confirm the mobile exit button
  (`#focusModeExitBtn`) turns it back off.
- Collab read-only/editing-mode: requires a running Durable Object
  backend (`wrangler dev`, not just `vite dev`) to seed a real shared-room
  join — flagged here as a known gap for the eventual implementation
  plan's live-verification step, not something this spec can pre-script
  cheaply the way the local-only paths above can be. At minimum,
  `undo`/`redo` routing should be checked against the local (non-collab)
  path, which the dev-server-only setup already covers.

## Self-review

- **Placeholder scan**: none — every moved function, store, and bridge
  change is concrete (real code sketches, not descriptions of intent).
- **Internal consistency**: the "what hasn't moved yet" list in
  Non-goals matches exactly what `buildExtensions()`'s
  `...window.MDE.getEditorExtensions()` spread still pulls in — nothing
  is claimed as moved in one section and left dangling in another.
- **Scope check**: one new store, one new pure-value module, one grown
  component, five bridge methods flipped to optional-and-relocated, two
  bridge methods removed outright. Dense but singular in purpose (the
  compartment/keybinding/focus-mode plumbing specifically) — right-sized
  for one implementation plan, consistent with why comment/image
  markers, slash commands, and wikilink autocomplete were deliberately
  cut to Phase B rather than folded in here.
- **Ambiguity check**: the one genuine judgment call in this spec —
  whether to also eliminate `setKeybindings`/`toggleFocusMode` outright
  versus just relocating their implementations — is resolved explicitly
  (eliminated, since grep confirms no other caller needs the bridge
  indirection once the stores exist) rather than left for the
  implementation plan to guess at.
