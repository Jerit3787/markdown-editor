# Editor Core Migration Design (Phase B)

## Context

Phase A (see `docs/superpowers/specs/2026-08-19-editor-core-migration-design.md`)
moved the editor-extension compartments (readOnly, editing-mode, focus-mode,
keybindings), keybinding-mode switching, and focus mode into `Editor.svelte`.
`app.ts`'s own `buildEditorExtensions()` still owns everything else that
feeds into `Editor.svelte` via `window.MDE.getEditorExtensions()`: formatting
keymaps, the markdown language, the four editor-feature `StateField`s this
phase covers, the save/preview `updateListener`, and paste/drop handlers.

This is Phase B of the seven-phase plan: the remaining editor-feature
extensions that are self-contained `StateField`s, not coupled to the
compartment plumbing Phase A already absorbed — comment markers, image
markers (including paste/drop upload), slash commands, and wikilink
autocomplete.

Same hard constraint as Phase A: everything becomes genuinely Svelte,
`$effect`/component-scoped state driving CodeMirror, not a relocated
`.ts` module that keeps the same imperative shape.

## Goals

- `imageMarkerField` and its three helpers (`addImageMarker`,
  `findImageMarker`, `removeImageMarker`) move into `Editor.svelte`'s
  `<script>` scope — pure CM-state helpers, no external dependencies.
- `insertImageWithUpload`, `imageFilesFrom`, `altTextFromFilename`,
  `readImageAsDataURL`, and the paste/drop `EditorView.domEventHandlers`
  move into `Editor.svelte`, importing `getActiveDoc`/`setDocImage` from
  `../stores/docs` and `imageKey` from `../image-key` directly (both
  already plain exports, no bridge involved) — same pattern collab.ts and
  gist.ts already use for `stores/docs.ts`.
- `commentMarkerField`, its three `StateEffect`s
  (`addCommentMarkerEffect`/`removeCommentMarkerEffect`/`clearCommentMarkersEffect`),
  and `commentDraftSyncListener` move into `Editor.svelte`, importing the
  `commentDraft` store directly.
- `slashTriggerField`/`slashMenuSyncListener` and
  `wikilinkTriggerField`/`wikilinkMenuSyncListener` move into
  `Editor.svelte`, importing the `slashMenu`/`wikilinkMenu` stores
  directly.
- The `Escape` key handler (closes the slash/wikilink popups) splits out
  of its current shared `keymap.of([...])` array — which also holds
  Mod-b/Mod-i/Mod-k, Phase D's — into its own `keymap.of([...])` that
  moves to `Editor.svelte` alongside the trigger fields it reads.
- `window.MDE.setCommentMarkers` moves from a required bridge method
  wrapping an app.ts closure function to an optional one
  (`setCommentMarkers?`) assigned by `Editor.svelte`'s `onMount` — same
  established pattern as Phase A's `undo`/`redo`/`setReadOnly`.
  `CommentsPanel.svelte`'s call site is unchanged.
- New optional bridge method `window.MDE.insertImageWithUpload`, assigned
  by `Editor.svelte`'s `onMount`. Needed because `initImageUploads()`
  (wiring the raw `#imageFileInput` element's `change` listener) stays in
  app.ts — see Non-goals.
- Inside `insertImageWithUpload`, the successful-upload path collapses
  `setDocImage(key, dataUrl); window.MDE.onImageAdded?.(...); ...;
  updatePreview();` down to one bridge call —
  `window.MDE.setDocImage(key, dataUrl)` — since that existing bridge
  method (`app.ts`'s `bridge.setDocImage`) already does both the store
  write and the preview refresh. `window.MDE.onImageAdded?.(key, dataUrl)`
  stays a separate call (collab.ts's mirror-to-room hook, unrelated to
  the preview refresh).
- No behavior change. Every one of the following must work identically
  after this phase: image paste/drop/toolbar-picker upload (including
  the placeholder-marker live-tracking through concurrent edits and the
  "too large"/"failed to load" error paths), comment marker
  highlighting and the comment-draft popup, slash-command menu
  trigger/query/close, wikilink autocomplete trigger/query/close, and
  Escape closing whichever of the two popups is open.

## Non-goals

- Formatting keymaps (`Mod-b`/`Mod-i`/`Mod-k`), `wrapSelection`,
  `insertLink` — Phase D. These stay in app.ts's `buildEditorExtensions()`
  remainder, in their own `keymap.of([...])` now that Escape has split
  out of that array.
- The `#imageFileInput` DOM element itself (defined in `index.html`, not
  any Svelte component) and its two call sites — `initImageUploads()`'s
  `change` listener (app.ts) and the toolbar/menu's `.click()` trigger
  inside `runCmd` (Phase D territory). Converting that raw element into
  something Svelte-owned overlaps Phase D's toolbar work and isn't part
  of the CodeMirror extension surface this phase covers. `app.ts` keeps
  `initImageUploads()`, now calling
  `window.MDE.insertImageWithUpload?.(file)` instead of the local
  closure function.
- `scheduleSave`, `updatePreview`, `updateCounts`,
  `followCursorInPreview`, `activeDocContent` — Phase C/E. The
  save/preview `updateListener` in `buildEditorExtensions()` is untouched;
  Editor.svelte's moved code calls `window.MDE.updatePreview()` where the
  original did, same as it calls `window.MDE.setDocImage(...)`.
- `runCmd`'s `"image"` command (opens the images manager modal, a
  different path from paste/drop/file-picker upload) — already
  bridge-mediated, untouched by this phase.
- Any UI/visual change. Structural move only.

## Architecture

### `Editor.svelte` additions

Appended to the shape Phase A already established — same instance-scoped
(non-`$state`) treatment for `imageMarkerIdSeq`, matching
`collabUndoManager`'s precedent from Phase A:

```svelte
<script lang="ts">
  // ...Phase A imports/compartments/effects unchanged...
  import { Decoration, StateField, StateEffect, type DecorationSet } from "@codemirror/view";
  import { markdown } from "@codemirror/lang-markdown";
  import { GFM } from "@lezer/markdown";
  import { getActiveDoc, setDocImage } from "../stores/docs";
  import { imageKey } from "../image-key";
  import { commentDraft } from "../stores/commentDraft";
  import { slashMenu } from "../stores/slashMenu";
  import { wikilinkMenu } from "../stores/wikilinkMenu";

  // ---------- Image markers (moved verbatim from app.ts) ----------
  let imageMarkerIdSeq = 0;
  const addImageMarkerEffect = StateEffect.define<{ id: number; from: number; to: number }>();
  const removeImageMarkerEffect = StateEffect.define<number>();
  const imageMarkerField = StateField.define<DecorationSet>({ /* ...verbatim... */ });

  function addImageMarker(from: number, to: number): number { /* ...verbatim... */ }
  function findImageMarker(id: number) { /* ...verbatim... */ }
  function removeImageMarker(id: number) { /* ...verbatim... */ }

  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

  function imageFilesFrom(dataTransfer: DataTransfer | null) { /* ...verbatim... */ }
  function altTextFromFilename(name: string) { /* ...verbatim... */ }
  function readImageAsDataURL(file: File): Promise<string> { /* ...verbatim... */ }

  function insertImageWithUpload(file: File, pos?: number) {
    const from = pos ?? view!.state.selection.main.head;
    if (file.size > MAX_IMAGE_BYTES) {
      view!.dispatch({ changes: { from, insert: `![${file.name}: image too large, 2MB max]()` } });
      return;
    }
    const placeholder = `![Encoding ${file.name}…]()`;
    const to = from + placeholder.length;
    view!.dispatch({ changes: { from, insert: placeholder } });
    const markerId = addImageMarker(from, to);

    readImageAsDataURL(file)
      .then((dataUrl) => {
        const range = findImageMarker(markerId);
        removeImageMarker(markerId);
        if (!range) return;
        const doc = getActiveDoc();
        if (!doc) return;
        const key = imageKey(file.name, doc.images || {});
        window.MDE.setDocImage(key, dataUrl); // store write + preview refresh, one call
        window.MDE.onImageAdded?.(key, dataUrl);
        view!.dispatch({ changes: { from: range.from, to: range.to, insert: `![${altTextFromFilename(file.name)}](${key})` } });
      })
      .catch((err) => {
        const range = findImageMarker(markerId);
        removeImageMarker(markerId);
        if (range) view!.dispatch({ changes: { from: range.from, to: range.to, insert: `![image failed to load: ${err.message}]()` } });
      });
  }

  // ---------- Comment markers (moved verbatim from app.ts) ----------
  const addCommentMarkerEffect = StateEffect.define<{ id: string; from: number; to: number }>();
  const removeCommentMarkerEffect = StateEffect.define<string>();
  const clearCommentMarkersEffect = StateEffect.define<null>();
  const commentMarkerField = StateField.define<DecorationSet>({ /* ...verbatim... */ });

  function setCommentMarkers(entries: { id: string; from: number; to: number }[]) {
    view!.dispatch({ effects: [clearCommentMarkersEffect.of(null), ...entries.map((e) => addCommentMarkerEffect.of(e))] });
  }

  const commentDraftSyncListener = EditorView.updateListener.of((update) => { /* ...verbatim, writes commentDraft store... */ });

  // ---------- Slash commands (moved verbatim from app.ts) ----------
  interface SlashTriggerState { open: boolean; triggerPos: number; }
  const closeSlashMenuEffect = StateEffect.define<null>();
  const slashTriggerField = StateField.define<SlashTriggerState | null>({ /* ...verbatim... */ });
  const slashMenuSyncListener = EditorView.updateListener.of((update) => { /* ...verbatim, writes slashMenu store... */ });

  // ---------- Wikilink autocomplete (moved verbatim from app.ts) ----------
  interface WikilinkTriggerState { open: boolean; triggerPos: number; }
  const closeWikilinkMenuEffect = StateEffect.define<null>();
  const wikilinkTriggerField = StateField.define<WikilinkTriggerState | null>({ /* ...verbatim... */ });
  const wikilinkMenuSyncListener = EditorView.updateListener.of((update) => { /* ...verbatim, writes wikilinkMenu store... */ });

  // Split out of app.ts's old combined keymap — this phase's fields only.
  const menuEscapeKeymap = keymap.of([
    {
      key: "Escape",
      run: (v) => {
        if (v.state.field(slashTriggerField)?.open) {
          v.dispatch({ effects: closeSlashMenuEffect.of(null) });
          return true;
        }
        if (v.state.field(wikilinkTriggerField)?.open) {
          v.dispatch({ effects: closeWikilinkMenuEffect.of(null) });
          return true;
        }
        return false;
      },
    },
  ]);

  function buildExtensions(): Extension[] {
    return [
      // ...Phase A's four compartments, syntaxHighlighting, editorTheme, drawSelection()...
      menuEscapeKeymap,
      imageMarkerField,
      commentMarkerField,
      commentDraftSyncListener,
      slashTriggerField,
      slashMenuSyncListener,
      wikilinkTriggerField,
      wikilinkMenuSyncListener,
      EditorView.domEventHandlers({
        paste: (event) => {
          const files = imageFilesFrom(event.clipboardData);
          if (files.length === 0) return false;
          event.preventDefault();
          files.forEach((file) => insertImageWithUpload(file));
          return true;
        },
        drop: (event, v) => {
          const files = imageFilesFrom(event.dataTransfer);
          if (files.length === 0) return false;
          event.preventDefault();
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
          files.forEach((file) => insertImageWithUpload(file, pos ?? undefined));
          return true;
        },
      }),
      // Still app.ts-owned, via getEditorExtensions() — see "Bridging
      // what hasn't moved yet" below.
      ...window.MDE.getEditorExtensions(),
    ];
  }

  onMount(() => {
    // ...Phase A's view construction, registerEditor, undo/redo/setReadOnly/
    // enterCollabMode/exitCollabMode assignments...
    window.MDE.setCommentMarkers = setCommentMarkers;
    window.MDE.insertImageWithUpload = insertImageWithUpload;
  });
</script>
```

### Bridging what hasn't moved yet

`buildEditorExtensions()`'s remainder (app.ts) shrinks again: drops the
four `StateField`s, their sync listeners, the paste/drop
`domEventHandlers`, and the `Escape` case out of its keymap array.
What's left: the Mod-b/Mod-i/Mod-k keymap (now on its own, no longer
sharing an array with Escape), Tab/Shift-Tab indent keymap,
`markdownKeymap`, `defaultKeymap`, `markdown({ extensions: [GFM] })`,
`EditorView.lineWrapping`, and the save/preview `updateListener`. Its doc
comment updates to name exactly this remainder, same convention Phase A
established.

### `client/src/types.ts` (`MDEBridge`) changes

- `setCommentMarkers`: moved from required to optional (`setCommentMarkers?`),
  matching the `publishGist?`/`undo?`/etc. precedent and doc-comment
  convention.
- New optional member: `insertImageWithUpload?(file: File, pos?: number): void;`
  — same doc-comment convention (assigned by `Editor.svelte` at mount;
  only reachable after mount, which is already guaranteed before any user
  action that could trigger it).
- `getEditorExtensions()`: kept, contract updated (doc comment only, no
  signature change) to describe the smaller remainder.

## Data flow

```
User pastes/drops an image, or picks one via the #imageFileInput picker
  │
  ▼
Editor.svelte's domEventHandlers (paste/drop) or
window.MDE.insertImageWithUpload (file-picker path, called from app.ts's
initImageUploads())
  │
  ▼
insertImageWithUpload: inserts placeholder, tracks it via
addImageMarker/imageMarkerField, reads the file async
  │
  ▼
on success: window.MDE.setDocImage(key, dataUrl) — stores.docs write +
  updatePreview() in one bridge call; window.MDE.onImageAdded?.() mirrors
  to a collab room if one is open; placeholder swapped for the real
  markdown image link
on failure: placeholder swapped for an inline error message

---

CommentsPanel.svelte: entries change
  │
  ▼
window.MDE.setCommentMarkers(entries)
  (function value now supplied by Editor.svelte's onMount, not app.ts)
  │
  ▼
commentMarkerField reconfigured via clearCommentMarkersEffect +
addCommentMarkerEffect per entry

---

User types "/" at the start of a line
  │
  ▼
slashTriggerField opens; slashMenuSyncListener writes the slashMenu store
  │
  ▼
SlashMenu.svelte (already Svelte, unchanged) renders from the store,
  its command run() calls route through window.MDE.runCmd(...) as before
  │
  ▼
Escape (now Editor.svelte's own keymap) or a completed selection closes it
```

## Error handling

- No new failure modes — every dispatch/effect path already exists today;
  this phase relocates which module calls it.
- The "image too large" and "failed to load" error paths are unchanged
  verbatim moves — same inline-markdown-error-text behavior.
- `window.MDE.setCommentMarkers`/`insertImageWithUpload` being optional
  now carries the same theoretical pre-mount-race risk Phase A's
  `undo`/`redo`/etc. already documented and accepted: not reachable in
  practice, since `CommentsPanel.svelte` and app.ts's `initImageUploads()`
  listener can only fire after the app (and therefore `Editor.svelte`'s
  `onMount`) has fully loaded.

## Testing

Same testing posture as Phase A — no unit-test precedent for Svelte
component internals or CodeMirror extension construction in this
codebase. Verified via live-browser technique (dev server + Chrome
automation, seeded `localStorage`):

- Image upload: paste an image, confirm the placeholder appears then
  resolves to a real embedded image; repeat via drag-drop; repeat via the
  toolbar/menu file-picker button; confirm an oversized file shows the
  "too large" message inline.
- Comment markers: open a document with existing comment entries via
  `CommentsPanel.svelte`, confirm highlights render at the right ranges;
  select text, confirm the comment-draft popup appears at the right
  position; add/delete a comment, confirm markers update.
- Slash commands: type "/" at a line start, confirm the menu opens and
  filters by query; run one command, confirm it inserts correctly and
  the menu closes; press Escape mid-query, confirm it closes without
  inserting.
- Wikilink autocomplete: type "[[", confirm the menu opens; type a
  partial document name, confirm filtering; press Escape, confirm it
  closes.
- Regression check on Phase A's own live-verification list (keybindings,
  focus mode, undo/redo) — cheap to re-run given the same dev-server
  setup, and this phase touches the same file.

## Self-review

- **Placeholder scan**: none — every moved function, field, and bridge
  change is concrete.
- **Internal consistency**: the Non-goals list (formatting keymaps,
  `#imageFileInput`'s own element, save/preview pipeline) matches exactly
  what `buildExtensions()`'s `...window.MDE.getEditorExtensions()` spread
  still pulls in per the Architecture section — nothing claimed as moved
  is left dangling in app.ts, and nothing claimed as staying is
  duplicated in Editor.svelte.
- **Scope check**: four `StateField`s, their sync listeners, image-upload
  logic, one keymap split, two bridge-method changes (one flipped
  optional, one new). Comparable density to Phase A, right-sized for one
  implementation plan.
- **Ambiguity check**: the two judgment calls this spec had to resolve —
  the Escape-keymap split (resolved: moves with the fields it reads, per
  explicit user decision) and whether `#imageFileInput`'s own DOM wiring
  moves (resolved: no, deferred past this phase's CodeMirror-extension
  scope, bridged instead) — are both stated explicitly rather than left
  for the implementation plan to guess at.
