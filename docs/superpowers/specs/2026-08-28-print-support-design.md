# Printing Support — Design Spec

**IMPROVEMENTS.md Phase 2 item:** "Printing support."

Today there is no way to print a document cleanly. Pressing the browser's native print shortcut (Ctrl/Cmd+P) or using the browser's own print menu entry prints the entire app chrome as-is — topbar, sidebar, toolbar, both editor and preview panes, comments panel, status bar — clipped to whatever fits the current viewport, since the app's own layout (`#app { height: 100dvh; overflow: hidden; }` and similar rules on `#content-row`/`#main`) is built for an on-screen single-viewport app, not a paginated print flow. There is already a separate "Export → PDF" action (`exportAs("pdf")` in `app.ts`, via `html2pdf.js`) that rasterizes the preview into a downloadable file, but nothing wires up a normal print flow.

## Goal

- A "Print" action, reachable from the File menu (next to the existing Export submenu) and the Command Palette, that opens the browser's native print dialog via `window.print()`.
- Regardless of the app's current view mode (editor-only, split, preview-only), printing always renders the clean, rendered **preview** — never the raw markdown source.
- A dedicated print stylesheet hides all app chrome (topbar, toolbar, sidebar, editor pane, comments panel, status bar, any mobile sheets/backdrops, the diagram editor) so only the rendered document content appears on paper.
- The layout chain that normally clips content to one viewport's height (`#app`, `#content-row`, `#main`, `#preview`) is reset under print media so multi-page documents paginate correctly instead of being cut off after one screen's worth of content.
- The printed page opens with the active document's name as a heading, since that name normally only lives in the (now-hidden) topbar.
- Because `@media print` rules apply regardless of *how* printing was triggered, this also fixes the browser's native Ctrl/Cmd+P shortcut — no keyboard interception needed.

## Non-goals (deferred)

- **No changes to the existing PDF export.** `exportAs("pdf")` and this new print flow are independent features that happen to produce visually similar output; this spec does not touch `exportPdf()`/`html2pdf.js` at all.
- **No print preview UI inside the app.** The browser's own native print preview (part of its print dialog) is the only preview surface — no custom in-app "preview before printing" screen.
- **No print-specific document settings** (paper size, margin presets, header/footer text, page numbers). These are all controllable through the browser's native print dialog already; this spec only makes the *content* clean, not adding app-level print configuration.
- **No printing of the raw markdown source.** Per the approved design, printing always uses the rendered preview regardless of which view mode is currently active.

## Components

### `client/index.html` (already modified)

Added an `#icon-printer` symbol to the icon sprite sheet (Lucide's `printer` glyph, same three-path shape used at lucide-static v1.34.0), next to the other recently-added icons:

```html
<symbol id="icon-printer" viewBox="0 0 24 24">
  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
  <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" />
  <rect x="6" y="14" width="12" height="8" rx="1" />
</symbol>
```

### `client/src/types.ts` (modify)

New `MDEBridge` method, declared next to `exportAs`:

```ts
printDocument(): Promise<void>;
```

### `client/src/app.ts` (modify)

New function, defined next to `exportAs` and following its exact same "flush any in-flight preview render first" precedent:

```ts
async function printDocument() {
  // Same reasoning as exportAs()'s txt/html/pdf branches — an in-flight
  // mermaid/math render triggered by a very recent edit shouldn't still
  // be showing its placeholder when the print dialog opens.
  await window.MDE.flushPreviewRenders?.();
  window.print();
}
```

Registered on the bridge object literal, directly after the existing `exportAs,` line:

```ts
exportAs,
printDocument,
```

### `client/src/components/Preview.svelte` (modify)

A new `activeDocTitle` piece of state, updated every time `updatePreview()` runs (mirroring how this file already re-derives everything else about the current document imperatively inside that function, rather than via a reactive store subscription — see its existing `const doc = getActiveDoc();` line):

```ts
let activeDocTitle = $state("");
```

Inside `updatePreview()`, immediately after the existing `const doc = getActiveDoc();`:

```ts
activeDocTitle = doc?.name ?? "";
```

Template addition, immediately before the existing `<div id="preview-mount">`:

```svelte
<h1 id="printDocTitle" class="print-only">{activeDocTitle}</h1>
```

`.print-only` is defined in the new print stylesheet (below) as `display: none` normally, `display: block` only under `@media print` — so this heading is fully inert on screen and has zero effect on the existing on-screen layout.

### `client/src/styles/_print.scss` (new)

```scss
.print-only {
  display: none;
}

@media print {
  // Chrome: hidden everywhere, regardless of current view mode or
  // screen size (mobile bottom-sheet variants of these same elements
  // are covered by the same selectors — they're the same DOM nodes,
  // just repositioned by mobile media queries on screen). #editorPane
  // (not the deeper #editorWrap Editor.svelte renders inside it) is
  // the actual flex child sized by #main's layout — hiding it here
  // rather than its descendant lets #previewPane below claim the
  // freed space cleanly. #divider is the drag handle between the two
  // panes, meaningless once one side is gone.
  #topbar,
  #topbar-row,
  #sidebar,
  #sidebarBackdrop,
  #editorPane,
  #divider,
  #comments-panel-mount,
  #statusbar,
  #diagram-editor-mount,
  .mobile-sheet-backdrop {
    display: none !important;
  }

  // The app's on-screen layout clips everything to one viewport's
  // height (#app: height:100dvh + overflow:hidden; #body/#content-row/
  // #main: flex/grid sizing meant for a fixed-height single screen) —
  // every ancestor in this chain needs overflow:visible + height:auto
  // so the browser's print pagination can actually see content past
  // the first screen's worth instead of clipping it there.
  html,
  body,
  #app,
  #body,
  #content-row,
  #main {
    height: auto !important;
    overflow: visible !important;
    display: block !important;
  }

  .print-only {
    display: block;
  }

  #printDocTitle {
    margin: 0 0 16px 0;
    font-size: 1.9em;
    line-height: 1.3;
  }

  // #previewPane is the actual .pane element with its own
  // flex:1/overflow:hidden/border-left — #preview-mount (display:
  // contents) and #preview itself (flex:1/overflow-y:auto/padding:40px)
  // both need the same reset one level deeper.
  #previewPane,
  #preview-mount,
  #preview {
    display: block !important;
    flex: none !important;
    width: 100% !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
    border-left: none !important;
    padding: 0 !important;
    font-size: 12pt;
    line-height: 1.5;
  }

  // Standard page-break hygiene: never split an image, code block, or
  // table across two pages, and never leave a heading stranded alone
  // at the bottom of a page with its content pushed to the next one.
  #preview {
    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      break-after: avoid;
    }

    img,
    pre,
    table {
      break-inside: avoid;
    }
  }
}
```

Added to `client/src/style.scss`'s `@use` list, last (after `utilities`) — print rules only ever match under `@media print`, so their position relative to the other partials' screen-media rules doesn't create any specificity race like the one found in the mobile overflow-menu bug; appending last simply keeps the newest partial at the bottom, matching how each prior feature's own partial was appended.

### `client/src/components/MenuBar.svelte` (modify)

New button, directly after the existing Export `menu-submenu` block (same divider/button pattern as every other File-menu action, `disabled={!hasActiveDoc}` matching Export's own guard):

```svelte
<div class="menu-divider"></div>
<button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.printDocument())}>
  <svg class="icon"><use href="#icon-printer"></use></svg> Print
</button>
```

### `client/src/components/CommandPalette.svelte` (modify)

New entry, grouped with the existing `Export` category entries (same `requires: "doc"` guard as `export-pdf`):

```ts
{ id: "print", label: "Print", category: "Export", run: () => window.MDE.printDocument(), requires: "doc" },
```

## Testing

New `tests/e2e/local/print.spec.ts`:

- **File menu Print action calls `window.print()`.** Stub `window.print` via `page.addInitScript` (or `page.evaluate` before navigation) to record calls without opening a real OS dialog, open the File menu, click Print, assert the stub was called exactly once.
- **Command Palette Print entry calls `window.print()`.** Same stubbing approach, open the Command Palette, run "Print", assert the stub was called.
- **Under print media, app chrome is hidden and the preview is shown.** `page.emulateMedia({ media: "print" })`, then assert `#topbar`, `#sidebar`, and `#editorPane` are not visible while `#preview` is visible — covering all three view modes (editor-only, split, preview-only) to confirm chrome is hidden and the preview shown regardless of the mode active at print time (view-mode CSS toggles `#editorPane`/`#previewPane` visibility via non-`!important` rules on `#body.mode-*`, which the print stylesheet's `!important` rules always win over).
- **The printed page shows the document title as a heading.** Under `page.emulateMedia({ media: "print" })`, assert `#printDocTitle` is visible and its text matches the active document's name; also assert it is *not* visible without `emulateMedia` (confirming `.print-only`'s screen-media `display: none` default).

No new unit-test file — `printDocument()`'s body is a two-line wrapper with no branching logic of its own to unit-test beyond what the e2e coverage above already exercises end-to-end.
