# Editor Core Migration Design (Phase C)

## Context

Phases A and B (see `docs/superpowers/specs/2026-08-19-editor-core-migration-design.md`
and `docs/superpowers/specs/2026-08-19-editor-core-migration-phase-b-design.md`)
moved the CodeMirror compartments, keybindings, focus mode, and the four
editor-feature `StateField`s (image/comment markers, slash commands,
wikilink autocomplete) into `Editor.svelte`. `app.ts`'s
`buildEditorExtensions()` is now down to formatting keymaps, the markdown
language, and one remaining `EditorView.updateListener` — the save/preview
listener Phase B's Non-goals explicitly deferred to "Phase C/E territory."

This is Phase C of the seven-phase plan: the preview pane — markdown
render pipeline, sync-scroll, and wikilink navigation-in-preview, moving
into a new `Preview.svelte`.

Same hard constraint as Phases A/B: everything becomes genuinely Svelte —
`Preview.svelte` owns its DOM mount and lifecycle the same way
`Editor.svelte` owns CodeMirror's, not a relocated `.ts` module.

## Goals

- New `Preview.svelte`, mounted at a new `#preview-mount` div in
  `index.html` (parallel to `#editor-mount`), owning:
  - `updatePreview()` — the full marked/DOMPurify render pipeline
    (image-ref resolution, mermaid code-block rendering, wikilink link
    rendering, math-span extraction, line-tagging for sync-scroll) and
    its paired `currentMathSources` state.
  - Sync-scroll: `syncingScroll`, `taggedPreviewBlocks`,
    `previewBlockForLine`, `previewBlockForScrollTop`,
    `editorPaddingTop`, `editorPixelRangeForLines`, `interpolateAcross`,
    `SYNC_SCROLL_END_SLACK_PX`, `initSyncScroll()`.
  - `initWikilinkNavigation()` (click-to-navigate on rendered
    `[[wikilinks]]` in the preview).
  - `followCursorInPreview()`.
  - `mermaidRenderScheduler`/`mathRenderScheduler` (both
    `debounceWithFlush`-based) and the `data-theme` `MutationObserver`
    that triggers a mermaid re-render on theme change.
  - `addDiagramEditButtons()` (only used by `mermaidRenderScheduler`'s
    callback — moves with it).
- New `client/src/escape-html.ts` module: `escapeHtml()` extracted
  verbatim out of app.ts (currently `app.ts:1342`). It's used both by
  `updatePreview()` (moving) and `exportAs()`'s HTML-export title
  (staying in app.ts, Phase F) — same treatment Phase A gave
  `editor-theme.ts`: a pure, zero-coupling piece pulled into its own
  module rather than bridged.
- `window.MDE.updatePreview`/`refreshPreview` flip from required to
  optional, assigned by `Preview.svelte`'s `onMount` — same pattern
  every prior phase's bridge changes followed. `DiagramEditor.svelte`'s
  existing `window.MDE.refreshPreview()` call site is unchanged.
- New optional bridge method `window.MDE.followCursorInPreview`,
  assigned the same way — called from app.ts's still-owned
  `updateListener` (see Architecture below for why the listener itself
  can't move).
- New optional bridge method `window.MDE.flushPreviewRenders`, assigned
  the same way — replaces `exportAs()`'s direct
  `mermaidRenderScheduler.flush()`/`mathRenderScheduler.flush()` calls,
  since both schedulers move into `Preview.svelte`.
- No behavior change. Every one of the following must work identically
  after this phase: live markdown rendering on every keystroke (mermaid
  diagrams, math, images, wikilinks, footnotes), sync-scroll in split
  view (both directions — editor→preview and preview→editor), clicking a
  `[[wikilink]]` in the rendered preview navigating to (or creating) the
  target document, the cursor-follow behavior in the preview pane, and
  `DiagramEditor.svelte`'s refresh-after-edit path.

## Non-goals

- `updateCounts()`, `updateCursorPos()`, `initShortStatus()` — status-bar
  concerns (`#wordCount`/`#charCount`/`#cursorPos`), not preview-pane
  ones, despite currently sharing app.ts's updateListener. Stay in
  app.ts; likely fold into `Editor.svelte` or a dedicated status-bar
  component in a later phase, not decided here.
- `resolveImageRefs`/`resolveDiagramRefs` — export/Gist-publish content
  resolution (`exportAs()`'s markdown branch, `getResolvedContent()`),
  not the live render pipeline, despite similar naming. Phase F
  (import/export) territory. Untouched.
- `setView()` / the editor-preview-split view-mode toggle itself — Phase
  D's (toolbar/view toggle). `Preview.svelte`'s sync-scroll keeps reading
  `#body`'s `mode-split` class the same way it does today (a read, not
  ownership, of Phase D's state).
- `scheduleSave()`, `activeDocContent` store writes — Phase E's (save
  status). The updateListener keeps calling these directly; only its
  preview-related two calls route through the bridge (see Architecture).
- Any UI/visual change. Structural move only.

## Architecture

### New: `client/src/escape-html.ts`

```typescript
export function escapeHtml(str: string): string {
  // moved verbatim from app.ts:1342
}
```

`Preview.svelte` and `app.ts` both import it. (Distinct from the
already-existing, unrelated `escapeHtml` in `client/src/version-preview.ts`
— that file keeps its own copy; no consolidation across those two, out of
scope here.)

### `buildEditorExtensions()`'s updateListener can't move wholesale

The listener does four things spanning three future phases:

```typescript
EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    scheduleSave();       // Phase E
    updatePreview();       // Phase C — this phase
    updateCounts();         // status bar, not this phase
    activeDocContent.set(cm.state.doc.toString());  // Phase E-adjacent
  }
  if (update.selectionSet) updateCursorPos();          // status bar
  if (update.docChanged || update.selectionSet) followCursorInPreview();  // Phase C
});
```

Since `scheduleSave`/`updateCounts`/`updateCursorPos`/the
`activeDocContent.set` write all stay app.ts-owned, the listener itself
stays in `buildEditorExtensions()`. Only its two preview-related calls
change to route through the bridge:

```typescript
EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    scheduleSave();
    window.MDE.updatePreview?.();
    updateCounts();
    activeDocContent.set(cm.state.doc.toString());
  }
  if (update.selectionSet) updateCursorPos();
  if (update.docChanged || update.selectionSet) window.MDE.followCursorInPreview?.();
});
```

This mirrors exactly how Phase A left app.ts's own remaining extensions
calling into `window.MDE.*` for anything `Editor.svelte` took over —
not a new pattern, a continuation of the established one.

**Design note on why this stays imperative, not `$effect`-driven:** unlike
Phase A/B's pieces (which react to Svelte *stores* — `keybindingMode`,
`focusMode`, etc.), `updatePreview`/`followCursorInPreview`'s trigger is a
raw CodeMirror transaction (`docChanged`/`selectionSet`), which has no
Svelte-store equivalent today. `Preview.svelte` could react to the
existing `activeDocContent` store via `$effect` for the *content-changed*
half, but `followCursorInPreview` also needs to fire on pure cursor
movement (`selectionSet` with no `docChanged`), which no store tracks.
Splitting the two triggers across two different mechanisms (one
`$effect`, one bridge call) would be more moving parts for no behavior
difference, so both stay bridge-called from the one place that already
observes both transaction kinds. Consistent with the "genuinely Svelte"
constraint's actual intent — owning the DOM/CodeMirror-adjacent logic
inside a component, not necessarily routing every trigger through
`$effect` when the source event has no natural store form.

### `exportAs()`'s scheduler-flush dependency

`exportAs()` (still app.ts, Phase F) awaits both schedulers' `.flush()`
before reading `#preview`'s rendered DOM for txt/html/pdf export, to
ensure in-flight diagram/math renders have landed:

```typescript
await mermaidRenderScheduler.flush();
await mathRenderScheduler.flush();
```

Once both schedulers move into `Preview.svelte`, this becomes:

```typescript
await window.MDE.flushPreviewRenders?.();
```

with `Preview.svelte` assigning:

```typescript
window.MDE.flushPreviewRenders = async () => {
  await mermaidRenderScheduler.flush();
  await mathRenderScheduler.flush();
};
```

### `Preview.svelte` — target shape

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import markedFootnote from "marked-footnote";
  import { get } from "svelte/store";
  import { getActiveDoc, docsStore, switchDoc as storeSwitchDoc, createDoc } from "../stores/docs";
  import { mermaidCodeRenderer, mermaidThemeFor, renderMermaidDiagrams } from "../mermaid-preview";
  import { extractMathSpans, renderMathPlaceholders, type MathSource } from "../math-preview";
  import { computeBlockLineStarts, computeListItemLineStarts } from "../scroll-sync";
  import { resolveWikilinkTarget, transformWikilinks } from "../wikilinks";
  import { debounceWithFlush } from "../debounce";
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { escapeHtml } from "../escape-html";

  // Registered once at module scope, same as app.ts's own top-level
  // marked.use() call today — moves here since this is now the only
  // consumer of marked's parse output.
  marked.use(markedFootnote({ headingClass: "sr-only" }));

  let hostEl: HTMLDivElement | undefined = $state();
  let syncingScroll = false;
  let currentMathSources: Map<string, MathSource> = new Map();

  function updatePreview() {
    // ...verbatim body from app.ts's updatePreview(), with `cm` replaced
    // by `window.MDE.getEditor()` and `document.getElementById("preview")`
    // replaced by `hostEl!` (the bound inner div — see template below)...
  }

  // ...taggedPreviewBlocks/previewBlockForLine/previewBlockForScrollTop/
  // editorPaddingTop/editorPixelRangeForLines/interpolateAcross/
  // SYNC_SCROLL_END_SLACK_PX: moved verbatim, `cm` -> window.MDE.getEditor()...

  function initSyncScroll() {
    // ...verbatim, using hostEl! instead of getElementById("preview")...
  }

  function initWikilinkNavigation() {
    hostEl!.addEventListener("click", (e) => {
      // ...verbatim...
    });
  }

  function followCursorInPreview() {
    // ...verbatim...
  }

  function addDiagramEditButtons() {
    // ...verbatim, hostEl! instead of getElementById("preview")...
  }

  const mermaidRenderScheduler = debounceWithFlush(() => {
    if (!hostEl) return;
    const theme = mermaidThemeFor(document.documentElement.getAttribute("data-theme"));
    return renderMermaidDiagrams(hostEl, theme).then(addDiagramEditButtons);
  }, 400);

  const mathRenderScheduler = debounceWithFlush(() => {
    if (!hostEl) return;
    return renderMathPlaceholders(hostEl, currentMathSources);
  }, 400);

  onMount(() => {
    initSyncScroll();
    initWikilinkNavigation();
    new MutationObserver(() => {
      void mermaidRenderScheduler.runNow();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    window.MDE.updatePreview = updatePreview;
    window.MDE.refreshPreview = updatePreview;
    window.MDE.followCursorInPreview = followCursorInPreview;
    window.MDE.flushPreviewRenders = async () => {
      await mermaidRenderScheduler.flush();
      await mathRenderScheduler.flush();
    };
  });
</script>

<div id="preview-mount">
  <div bind:this={hostEl} id="preview"></div>
</div>
```

The inner div keeps `id="preview"` (not renamed) — every existing
`#preview`-scoped CSS rule (`client/src/style.css`, descendant selectors
only, confirmed no nesting-depth-sensitive combinators) and every other
`document.getElementById("preview")` read (`exportAs()`'s txt/html/pdf
export, `updateMainView()`'s visibility toggling — both stay app.ts-owned
per Non-goals) keeps working unchanged; the only new element is the
outer `#preview-mount` wrapper `Preview.svelte` itself binds to. Mirrors
`Editor.svelte`'s own `<div id="editorWrap"><div bind:this={hostEl}
class="cm-host"></div></div>` shape exactly.

### `index.html` change

```html
<section id="previewPane" class="pane">
  <div id="preview-mount"></div>
</section>
```

(was `<div id="preview"></div>` directly — `Preview.svelte` now renders
its own inner `#preview` div into this mount point, same relationship
`#editor-mount`/`Editor.svelte` already has.)

### `client/src/types.ts` (`MDEBridge`) changes

- `updatePreview(): void;` and `refreshPreview(): void;` move from
  required to optional (`updatePreview?()`, `refreshPreview?()`),
  matching the established doc-comment convention.
- New optional members, same convention:
  `followCursorInPreview?(): void;`,
  `flushPreviewRenders?(): Promise<void>;`.

### app.ts changes

- `updatePreview()`, `currentMathSources`, all sync-scroll code,
  `initWikilinkNavigation()`, `followCursorInPreview()`,
  `mermaidRenderScheduler`/`mathRenderScheduler`/`addDiagramEditButtons`,
  the theme-change `MutationObserver`, and `escapeHtml` are deleted from
  app.ts (the last two replaced by the new shared import).
- `init()`'s calls to `initSyncScroll()`/`initWikilinkNavigation()` are
  deleted (moved to `Preview.svelte`'s `onMount`, same timing guarantee
  — Svelte component `onMount`s already run before `main.ts`'s
  `DOMContentLoaded`-gated `init()`, the identical guarantee Phase A's
  `Editor.svelte` relies on).
- The updateListener's two preview-related calls route through the
  bridge (see Architecture above).
- `init()`'s `activeIdStore.subscribe(...)` callback (which calls both
  `updatePreview()` and `updateCounts()` on every doc switch) changes its
  `updatePreview()` call to `window.MDE.updatePreview?.()`.
- The bridge's `refreshPreview() { updatePreview(); }` wrapper and the
  bridge's `setDocImage(key, dataUrl) { setDocImage(key, dataUrl);
  updatePreview(); }` wrapper both change their inner call to
  `window.MDE.updatePreview?.()` — both are hidden non-obvious callers of
  the local `updatePreview` closure, found via this phase's own research
  pass (the same category of gap Phase B's `setCommentMarkers` hit:
  three real callers existed, not the one obvious updateListener call).
- `exportAs()`'s two `.flush()` calls become the one
  `await window.MDE.flushPreviewRenders?.();` call (see Architecture).

## Data flow

```
User types in the editor
  │
  ▼
Editor.svelte's CodeMirror instance fires its updateListener
(still app.ts-constructed, spliced in via window.MDE.getEditorExtensions())
  │
  ▼
docChanged: scheduleSave() [app.ts] → window.MDE.updatePreview?.() [Preview.svelte]
  → updateCounts() [app.ts] → activeDocContent.set(...) [store]
selectionSet: updateCursorPos() [app.ts]
either: window.MDE.followCursorInPreview?.() [Preview.svelte]
  │
  ▼
Preview.svelte's updatePreview(): marked.parse + DOMPurify.sanitize →
  hostEl.innerHTML = clean → line-tags blocks/list-items for sync-scroll →
  triggers mermaidRenderScheduler/mathRenderScheduler (debounced)

---

User clicks a [[wikilink]] in the rendered preview
  │
  ▼
Preview.svelte's initWikilinkNavigation click handler (delegated on hostEl)
  │
  ▼
resolveWikilinkTarget(name, get(docsStore)) → storeSwitchDoc(target.id)
  or createDoc({ name }) if the target doesn't exist yet

---

DiagramEditor.svelte: user saves an edited diagram
  │
  ▼
window.MDE.refreshPreview() (now Preview.svelte's updatePreview,
  assigned at mount instead of app.ts's bridge wrapper)

---

exportAs("pdf")  [app.ts, Phase F]
  │
  ▼
await window.MDE.flushPreviewRenders?.()
  (Preview.svelte's own mermaidRenderScheduler.flush() + mathRenderScheduler.flush())
  │
  ▼
reads #preview's now-settled innerHTML/innerText for the export
```

## Error handling

- No new failure modes — every dispatch/render path already exists
  today; this phase relocates who owns it.
- The four now-optional bridge methods carry the same
  pre-mount-race-in-theory-but-not-in-practice note every prior phase's
  optional bridge additions already documented: `Preview.svelte`'s
  `onMount` runs before app.ts's `DOMContentLoaded`-gated `init()`, so by
  the time anything could call `window.MDE.updatePreview()` et al., it's
  already assigned.
- `initWikilinkNavigation()`'s delegated-listener approach is unchanged —
  still resilient to `updatePreview()` replacing the entire `innerHTML`
  every keystroke, since the listener lives on the stable outer `hostEl`,
  not on the replaced content itself.

## Testing

Same posture as Phases A/B — no unit-test precedent for Svelte component
internals or this kind of DOM-heavy render pipeline in this codebase.
Verified via live-browser technique (dev server + Chrome automation,
seeded `localStorage`):

- Live rendering: type markdown covering headings, a mermaid fence, a
  math span, an image reference, a `[[wikilink]]`, a footnote — confirm
  the preview pane renders all of them correctly and updates on every
  keystroke.
- Sync-scroll: in split view, scroll the editor and confirm the preview
  follows proportionally to the nearest tagged block; scroll the preview
  and confirm the editor follows back; confirm the `mode-split` gate
  actually disables sync-scroll outside split view.
- Wikilink navigation: click an existing `[[wikilink]]` in the rendered
  preview, confirm it switches documents; click a non-existent one,
  confirm it creates a new document with that name.
- Cursor-follow: move the cursor without changing text (arrow keys),
  confirm the preview scrolls to follow.
- Diagram edit-in-place: use `DiagramEditor.svelte` to edit an existing
  mermaid diagram, save, confirm the preview refreshes without a full
  keystroke-triggered re-render.
- Theme toggle: switch light/dark, confirm mermaid diagrams re-render in
  the new theme's colors via the `MutationObserver`.
- Export: run `txt`/`html`/`pdf` export on a document containing a mermaid
  diagram and confirm the exported output includes the fully-rendered
  diagram (not raw fence source) — this exercises
  `flushPreviewRenders?.()`.
- Regression spot-check on Phase A/B's own live-verification (keybindings,
  focus mode, undo/redo, image upload, comment markers, slash/wikilink
  editor-side triggers) — cheap given the shared dev-server setup.

## Self-review

- **Placeholder scan**: none — every moved function, store, and bridge
  change is concrete; verbatim-move sections are explicitly marked as
  such with a pointer to the exact current app.ts location, matching
  Phase A/B's own convention for genuinely unchanged logic.
- **Internal consistency**: the Non-goals list (status bar, export
  content-resolution, view-mode toggle, save pipeline) matches exactly
  what stays in app.ts per the Architecture section — nothing claimed as
  moved is left dangling, nothing claimed as staying is duplicated into
  `Preview.svelte`.
- **Scope check**: one new component, one new pure-value module, four
  bridge-method changes (two flipped optional, two new). Comparable
  density to Phases A/B, right-sized for one implementation plan.
- **Ambiguity check**: the mount-point question (new `#preview-mount` vs.
  reusing the raw `#preview` id) was resolved explicitly via user
  decision rather than left for the implementation plan to guess at. The
  updateListener-can't-move-wholesale structural constraint, and the
  three real (not one obvious) callers of `updatePreview()` found via
  this phase's research pass, are both documented explicitly so the
  implementation plan doesn't have to rediscover them mid-task the way
  Phase B's `setCommentMarkers` gap was found only via `tsc` errors.
