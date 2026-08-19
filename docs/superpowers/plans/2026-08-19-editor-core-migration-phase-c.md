# Editor Core Migration Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the markdown render pipeline, sync-scroll, and wikilink
navigation-in-preview out of `client/src/app.ts` and into a new
`client/src/components/Preview.svelte`, continuing the Phase A/B pattern
of component-owned DOM/CodeMirror-adjacent logic instead of app.ts's old
imperative closure style.

**Architecture:** `escapeHtml` is a tiny, zero-coupling pure function used
by both the moving render pipeline and app.ts's still-owned HTML export —
extracted into its own module first (`escape-html.ts`), same treatment
Phase A gave `editor-theme.ts`. Everything else (`updatePreview()`,
sync-scroll, wikilink navigation, follow-cursor, the two render
schedulers) is tightly interdependent — `previewBlockForLine` is shared
by sync-scroll and follow-cursor, `currentMathSources` is written by
`updatePreview()` and read by the math scheduler — so it moves as one
atomic unit into `Preview.svelte`, verified as a whole, the same way
Phase A moved the compartments/keybindings/focus-mode as a single task
rather than splitting a tightly-coupled unit across commits.

**Tech Stack:** Svelte 5 (`onMount`), `marked` + `marked-footnote` +
DOMPurify (render pipeline), CodeMirror 6 (read-only access via
`window.MDE.getEditor()`), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-editor-core-migration-phase-c-design.md`
(and Phases A/B's specs, `docs/superpowers/specs/2026-08-19-editor-core-migration-design.md`
and `docs/superpowers/specs/2026-08-19-editor-core-migration-phase-b-design.md`,
for the bridge/compartment conventions this plan continues).

## Global Constraints

- No behavior change — every moved piece is a verbatim relocation
  (`cm` → `window.MDE.getEditor()`, `document.getElementById("preview")`
  → the component's own bound `hostEl`), no logic rewritten, per the
  spec's Goals section.
- New/changed `MDEBridge` optional methods follow the exact doc-comment
  convention Phases A/B established for `undo?`/`insertImageWithUpload?`/
  etc. (see `client/src/types.ts:182-202`).
- `Preview.svelte` mounts at a new `#preview-mount` div (per the spec's
  resolved mount-point decision); the inner rendered-content div keeps
  `id="preview"` unchanged, so every existing `#preview`-scoped CSS rule
  and every other `document.getElementById("preview")` read (still
  app.ts-owned: `exportAs()`, `updateMainView()`) keeps working
  unmodified.
- No new unit tests — this codebase has no precedent for testing Svelte
  component internals or this kind of DOM-heavy render pipeline
  (verified via `find client/src/components -name "*.test.ts"` returning
  nothing, same as every prior phase). Verification is
  `tsc`/`svelte-check`/`npm test` (regression only) plus live-browser
  verification.
- `git commit` after each task, in the worktree already created for this
  phase (`.worktrees/editor-core-migration-phase-c`, branch
  `editor-core-migration-phase-c`) — no need to create a new one.

---

### Task 1: Extract `escapeHtml` into its own module

**Files:**
- Create: `client/src/escape-html.ts`
- Modify: `client/src/app.ts:1342-1346` (remove), `client/src/app.ts`
  (add import)

**Interfaces:**
- Produces: `escapeHtml(str: string): string`, importable from
  `./escape-html` (app.ts) / `../escape-html` (future
  `client/src/components/Preview.svelte`, added in Task 2).

- [ ] **Step 1: Create `client/src/escape-html.ts`**

```typescript
export function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
```

(Moved verbatim from `app.ts:1342-1346` — this is a distinct function
from the unrelated, separately-maintained `escapeHtml` already in
`client/src/version-preview.ts`; no consolidation between those two.)

- [ ] **Step 2: Replace app.ts's local definition with an import**

Delete the local function (`app.ts:1342-1346`):

```typescript
  function escapeHtml(str: string) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
```

Add the import near app.ts's other local-module imports (alongside
`import { resolveDiagramRefs } from "./diagram-refs";`, `app.ts:39`):

```typescript
import { escapeHtml } from "./escape-html";
```

- [ ] **Step 3: Verify**

```bash
cd client && npx tsc --noEmit
```

Expected: clean (app.ts's one remaining `escapeHtml` caller —
`exportAs()`'s HTML export, `app.ts:1587` — now resolves to the
imported function instead of the deleted local one).

```bash
cd .. && npm test 2>&1 | tail -10
```

Expected: all existing tests pass (this task adds no new tests).

- [ ] **Step 4: Commit**

```bash
git add client/src/escape-html.ts client/src/app.ts
git commit -m "$(cat <<'EOF'
refactor: extract escapeHtml into its own module

Pure, zero-coupling function used both by the still-app.ts-owned HTML
export and by Phase C's soon-to-move preview render pipeline — same
treatment Phase A gave editor-theme.ts.
EOF
)"
```

---

### Task 2: Create `Preview.svelte`, shrink `app.ts`, update the bridge

This is one atomic task, not split further — `updatePreview()`,
sync-scroll, wikilink navigation, and follow-cursor share too much
internal state (`previewBlockForLine`/`editorPixelRangeForLines` used by
both sync-scroll and follow-cursor; `currentMathSources` written by
`updatePreview()` and read by the math scheduler) to safely move in
separately-compilable increments — this mirrors how Phase A moved its
own tightly-coupled compartments/keybindings/focus-mode as a single task.

**Files:**
- Create: `client/src/components/Preview.svelte`
- Modify: `client/src/app.ts` (imports, deletions throughout — see
  Steps 6-11 for exact locations), `client/src/types.ts` (bridge
  interface), `client/src/index.html:417-419`, `client/src/main.ts`

**Interfaces:**
- Consumes: `window.MDE.getEditor(): EditorView` (existing, Phase A),
  `escapeHtml` from `../escape-html` (Task 1).
- Produces: `window.MDE.updatePreview?(): void`,
  `window.MDE.refreshPreview?(): void`,
  `window.MDE.followCursorInPreview?(): void`,
  `window.MDE.flushPreviewRenders?(): Promise<void>` — all assigned by
  `Preview.svelte`'s `onMount`. `DiagramEditor.svelte:237`'s existing
  `window.MDE.refreshPreview()` call, and app.ts's remaining
  `updateListener`/`activeIdStore.subscribe`/`exportAs()` call sites
  (Steps 9-10), are this task's callers.

- [ ] **Step 1: Create `client/src/components/Preview.svelte` — imports and state**

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

  // Registered once, at module scope — marked.use() mutates the shared
  // marked singleton permanently, so this must never run inside
  // updatePreview() or any other per-render function. Moved verbatim
  // from app.ts's own top-level registration (Phase C of the
  // editor-core migration) — this is now the sole consumer of marked's
  // parse output. headingClass: "sr-only" — the package's default
  // heading text ("Footnotes") for the trailing section is meant to be
  // visually hidden but screen-reader-visible; style.css defines
  // .sr-only for this. refMarkers left at its default (false) for bare
  // superscript numbers, matching GitHub's own footnote rendering.
  marked.use(markedFootnote({ headingClass: "sr-only" }));

  let hostEl: HTMLDivElement | undefined = $state();
  let syncingScroll = false;
  let currentMathSources: Map<string, MathSource> = new Map();
</script>
```

- [ ] **Step 2: Add the render pipeline (`updatePreview()`)**

```svelte
  function updatePreview() {
    const view = window.MDE.getEditor();
    const raw = view.state.doc.toString();
    const doc = getActiveDoc();
    const renderer = new marked.Renderer();
    // ![alt](refName) resolves against doc.images; anything not a known
    // ref (a real URL, or an old doc predating this feature that still has
    // the full data URI inline) passes through untouched. marked 18's
    // renderer overrides take a single token object, not positional args
    // (changed across the marked 12 -> 18 upgrade — verified against the
    // actual loaded version's marked.d.ts, not assumed).
    renderer.image = ({ href, title, text }) => {
      const resolved = doc && doc.images && doc.images[href] ? doc.images[href] : href;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(text || "")}"${titleAttr}>`;
    };
    // ```mermaid fences render as diagrams (see mermaid-preview.ts); every
    // other language falls through to marked's own default code renderer.
    // mermaidCodeRenderer() itself keeps its original positional (code,
    // infostring, escaped) signature — it's a plain, independently-tested
    // utility with no marked-specific shape of its own — so the object <->
    // positional conversion happens only here, at the marked boundary.
    const defaultCodeRenderer = marked.Renderer.prototype.code.bind(renderer);
    renderer.code = ({ text, lang, escaped }) =>
      mermaidCodeRenderer(
        text,
        lang,
        !!escaped,
        (code, infostring, esc) => defaultCodeRenderer({ type: "code", raw: code, text: code, lang: infostring, escaped: esc }),
        doc?.diagrams
      );
    // [[Name]] links (see wikilinks.ts's transformWikilinks, applied
    // below) become "wikilink:"-scheme links — resolved against the
    // current document list at render time so a rename/delete elsewhere
    // is reflected on the next keystroke, same as every other preview
    // content.
    const defaultLinkRenderer = marked.Renderer.prototype.link.bind(renderer);
    renderer.link = ({ href, title, text, tokens }) => {
      if (!href.startsWith("wikilink:")) return defaultLinkRenderer({ type: "link", raw: href, href, title: title ?? null, text, tokens: tokens ?? [] });
      const name = decodeURIComponent(href.slice("wikilink:".length));
      const exists = !!resolveWikilinkTarget(name, get(docsStore));
      const cls = exists ? "wikilink" : "wikilink wikilink-missing";
      return `<a href="#" class="${cls}" data-doc-name="${escapeHtml(name)}">${escapeHtml(text)}</a>`;
    };
    const { text: extractedRaw, sources } = extractMathSpans(transformWikilinks(raw));
    currentMathSources = sources;
    const html = marked.parse(extractedRaw, { gfm: true, breaks: false, renderer }) as string;
    // KaTeX's output includes a MathML companion tree (for accessibility)
    // alongside its visible HTML — DOMPurify's default allowlist is
    // HTML-only and strips MathML entirely without ADD_TAGS/ADD_ATTR
    // below. Verified against real katex.renderToString() output
    // (sqrt, frac, sum, matrix, vector/underline) — nothing else needed.
    const clean = DOMPurify.sanitize(html, {
      ADD_TAGS: ["math", "semantics", "mrow", "mi", "mn", "mo", "msup", "msub", "msubsup", "msqrt", "mroot", "mfrac", "mtable", "mtr", "mtd", "mspace", "mtext", "mstyle", "mover", "munder", "munderover", "mpadded", "annotation"],
      ADD_ATTR: ["target", "mathvariant", "encoding", "xmlns"],
    });
    const previewEl = hostEl!;
    // marked.parse() always regenerates every ```mermaid fence as its raw
    // source text (mermaidCodeRenderer has no way to know a diagram was
    // already rendered), and this whole function re-runs on every
    // keystroke anywhere in the document — so without this, every
    // existing diagram would flash back to raw source text on every
    // keystroke, only catching up once mermaidRenderScheduler's debounced
    // pass fires ~400ms later. Snapshot already-rendered diagrams here,
    // keyed by the exact source they were rendered from (same identity
    // mermaid-preview.ts itself uses for its own data-mermaid-source
    // cache), and splice the still-current ones back in immediately below
    // — only a diagram whose source actually changed, or one seen for the
    // first time, still needs to wait for the real re-render.
    const renderedDiagrams = new Map<string, Element>();
    previewEl.querySelectorAll("pre.mermaid.mermaid-rendered[data-mermaid-source]").forEach((el) => {
      const source = el.getAttribute("data-mermaid-source");
      if (source !== null) renderedDiagrams.set(source, el);
    });
    previewEl.innerHTML = clean;
    if (renderedDiagrams.size > 0) {
      previewEl.querySelectorAll("pre.mermaid").forEach((el) => {
        const cached = renderedDiagrams.get(el.textContent ?? "");
        if (cached) el.replaceWith(cached);
      });
    }
    // Tags each top-level preview block with the source line it was
    // rendered from, for sync-scroll (see initSyncScroll()) to snap to
    // instead of using raw scroll percentage — which breaks down badly
    // once a block's rendered height (a tall diagram, a large image) is
    // very disproportionate to how many source lines it represents.
    // computeBlockLineStarts() runs on the *original* raw text (not
    // extractedRaw) — see its own comment for why. Non-space top-level
    // tokens and top-level DOM children correspond 1:1 in order for
    // every standard block type; the length-capped loop degrades
    // gracefully (leaving a mismatched tail untagged) rather than
    // throwing if some edge case ever breaks that correspondence.
    const lineStarts = computeBlockLineStarts(raw);
    const previewChildren = Array.from(previewEl.children);
    for (let i = 0; i < lineStarts.length && i < previewChildren.length; i++) {
      previewChildren[i].setAttribute("data-line", String(lineStarts[i]));
    }
    // A list block's own single tag only anchors interpolation at its
    // first item — for any list with more than a couple of items, the
    // editor's fixed-width wrapping and the preview's proportional-font
    // wrapping diverge per item, not just once per block, which left
    // scroll-sync/cursor-follow landing well off from the item actually
    // being edited the deeper into a list you went. Tagging each <li>
    // with its own start line (same [data-line] convention everything
    // else already keys off) gives the same interpolation one anchor
    // per item instead of one per whole list.
    const listItemLineStarts = computeListItemLineStarts(raw);
    for (let i = 0; i < listItemLineStarts.length && i < previewChildren.length; i++) {
      const itemLines = listItemLineStarts[i];
      if (!itemLines) continue;
      const liEls = Array.from(previewChildren[i].children).filter((el): el is HTMLElement => el.tagName === "LI");
      for (let j = 0; j < itemLines.length && j < liEls.length; j++) {
        liEls[j].setAttribute("data-line", String(itemLines[j]));
      }
    }
    mermaidRenderScheduler.trigger();
    mathRenderScheduler.trigger();
  }
```

- [ ] **Step 3: Add the render schedulers and diagram-edit buttons**

```svelte
  // Runs after every mermaid render pass — adds a hover-revealed "Edit"
  // button to each diagram backed by a real ref (see mermaid-preview.ts's
  // data-diagram-ref). Idempotent: skips a block that already has one, so
  // it's safe to call after every render, not just the first.
  function addDiagramEditButtons() {
    if (!hostEl) return;
    hostEl.querySelectorAll(".mermaid[data-diagram-ref]").forEach((block) => {
      if (block.querySelector(".mermaid-edit-btn")) return;
      const ref = block.getAttribute("data-diagram-ref");
      if (!ref) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mermaid-edit-btn";
      btn.textContent = "Edit";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        diagramEditorRef.set(ref);
        diagramEditorOpen.set(true);
      });
      block.appendChild(btn);
    });
  }

  // Diagrams re-render on a debounce (mirrors app.ts's own save debounce)
  // so typing inside/near a ```mermaid fence doesn't re-layout SVG on
  // every keystroke; theme changes and export force an immediate run
  // instead — see mermaidRenderScheduler.runNow()/.flush() call sites.
  const mermaidRenderScheduler = debounceWithFlush(() => {
    if (!hostEl) return;
    const theme = mermaidThemeFor(document.documentElement.getAttribute("data-theme"));
    return renderMermaidDiagrams(hostEl, theme).then(addDiagramEditButtons);
  }, 400);

  const mathRenderScheduler = debounceWithFlush(() => {
    if (!hostEl) return;
    return renderMathPlaceholders(hostEl, currentMathSources);
  }, 400);
```

- [ ] **Step 4: Add sync-scroll**

```svelte
  // Shared across initSyncScroll()'s explicit-scroll listeners and
  // followCursorInPreview() below (cursor/typing-driven, not scroll-event
  // driven) so the two can't fight each other via feedback loops.
  interface PreviewBlockMatch {
    element: HTMLElement;
    startLine: number;
    endLine: number; // exclusive — the next block's start line, or doc.lines for the last block
    top: number; // this block's offsetTop
    bottom: number; // the next block's offsetTop, or the preview's full scrollHeight for the last block
  }

  function taggedPreviewBlocks(preview: HTMLElement): { element: HTMLElement; line: number }[] {
    return Array.from(preview.querySelectorAll<HTMLElement>("[data-line]")).map((element) => ({
      element,
      line: Number(element.getAttribute("data-line")),
    }));
  }

  function previewBlockForLine(preview: HTMLElement, line: number, totalLines: number): PreviewBlockMatch | undefined {
    const blocks = taggedPreviewBlocks(preview);
    let idx = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].line <= line) idx = i;
      else break; // tagged elements are in document order — line numbers are non-decreasing
    }
    if (idx === -1) return undefined;

    const endLine = idx + 1 < blocks.length ? blocks[idx + 1].line : totalLines;
    const bottom = idx + 1 < blocks.length ? blocks[idx + 1].element.offsetTop : preview.scrollHeight;
    return { element: blocks[idx].element, startLine: blocks[idx].line, endLine, top: blocks[idx].element.offsetTop, bottom };
  }

  function previewBlockForScrollTop(preview: HTMLElement, scrollTop: number, totalLines: number): PreviewBlockMatch | undefined {
    const blocks = taggedPreviewBlocks(preview);
    if (blocks.length === 0) return undefined;

    let idx = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].element.offsetTop <= scrollTop) idx = i;
      else break;
    }
    const endLine = idx + 1 < blocks.length ? blocks[idx + 1].line : totalLines;
    const bottom = idx + 1 < blocks.length ? blocks[idx + 1].element.offsetTop : preview.scrollHeight;
    return { element: blocks[idx].element, startLine: blocks[idx].line, endLine, top: blocks[idx].element.offsetTop, bottom };
  }

  // .cm-content's own CSS top padding (style.css). CodeMirror's line-block
  // coordinates are always relative to the top of the document text
  // itself (padding excluded); scrollDOM.scrollTop is a physical DOM
  // scroll position that DOES include that padding as scrollable space
  // above line 1 — every conversion between the two needs this offset.
  function editorPaddingTop(): number {
    return parseFloat(getComputedStyle(window.MDE.getEditor().contentDOM).paddingTop) || 0;
  }

  function editorPixelRangeForLines(startLine: number, endLine: number): { top: number; bottom: number } {
    const view = window.MDE.getEditor();
    const totalLines = view.state.doc.lines;
    const paddingTop = editorPaddingTop();
    const top = view.lineBlockAt(view.state.doc.line(Math.min(startLine + 1, totalLines)).from).top + paddingTop;
    const bottom = endLine < totalLines
      ? view.lineBlockAt(view.state.doc.line(endLine + 1).from).top + paddingTop
      : view.scrollDOM.scrollHeight;
    return { top, bottom };
  }

  // Maps pos's fraction through [fromTop, fromBottom) onto [toTop, toBottom).
  function interpolateAcross(pos: number, fromTop: number, fromBottom: number, toTop: number, toBottom: number): number {
    const span = Math.max(1, fromBottom - fromTop);
    const fraction = Math.min(1, (pos - fromTop) / span);
    return Math.max(0, toTop + fraction * (toBottom - toTop));
  }

  // How close to a pane's absolute max scrollTop still counts as "at the
  // end" for the at-max special case below.
  const SYNC_SCROLL_END_SLACK_PX = 8;

  function initSyncScroll() {
    const view = window.MDE.getEditor();
    const body = document.getElementById("body") as HTMLElement;
    const preview = hostEl!;

    view.scrollDOM.addEventListener("scroll", () => {
      if (syncingScroll || !body.classList.contains("mode-split")) return;
      const el = view.scrollDOM;
      const editorMax = el.scrollHeight - el.clientHeight;
      if (editorMax <= 0) return;
      if (el.scrollTop >= editorMax - SYNC_SCROLL_END_SLACK_PX) {
        syncingScroll = true;
        preview.scrollTop = preview.scrollHeight - preview.clientHeight;
        requestAnimationFrame(() => { syncingScroll = false; });
        return;
      }
      if (el.scrollTop <= SYNC_SCROLL_END_SLACK_PX) {
        syncingScroll = true;
        preview.scrollTop = 0;
        requestAnimationFrame(() => { syncingScroll = false; });
        return;
      }
      const topLine = view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, el.scrollTop - editorPaddingTop())).from).number - 1;
      const match = previewBlockForLine(preview, topLine, view.state.doc.lines);
      if (!match) return;
      const editorRange = editorPixelRangeForLines(match.startLine, match.endLine);
      syncingScroll = true;
      preview.scrollTop = interpolateAcross(el.scrollTop, editorRange.top, editorRange.bottom, match.top, match.bottom);
      requestAnimationFrame(() => { syncingScroll = false; });
    });

    preview.addEventListener("scroll", () => {
      if (syncingScroll || !body.classList.contains("mode-split")) return;
      const previewMax = preview.scrollHeight - preview.clientHeight;
      if (previewMax <= 0) return;
      if (preview.scrollTop >= previewMax - SYNC_SCROLL_END_SLACK_PX) {
        syncingScroll = true;
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end" }) });
        requestAnimationFrame(() => { syncingScroll = false; });
        return;
      }
      if (preview.scrollTop <= SYNC_SCROLL_END_SLACK_PX) {
        syncingScroll = true;
        view.scrollDOM.scrollTop = 0;
        requestAnimationFrame(() => { syncingScroll = false; });
        return;
      }
      const match = previewBlockForScrollTop(preview, preview.scrollTop, view.state.doc.lines);
      if (!match) return;
      const editorRange = editorPixelRangeForLines(match.startLine, match.endLine);
      syncingScroll = true;
      view.scrollDOM.scrollTop = interpolateAcross(preview.scrollTop, match.top, match.bottom, editorRange.top, editorRange.bottom);
      requestAnimationFrame(() => { syncingScroll = false; });
    });
  }
```

This introduces one new import not listed in Step 1: `EditorView` (for
`EditorView.scrollIntoView(...)`, a static method, not an instance).
Go back and add it to Step 1's imports:

```svelte
  import { EditorView } from "@codemirror/view";
```

- [ ] **Step 5: Add wikilink navigation and follow-cursor**

```svelte
  // One delegated listener on the stable preview host, not per-element —
  // updatePreview() replaces the whole innerHTML on every keystroke, so
  // per-element listeners would need constant re-attachment.
  function initWikilinkNavigation() {
    hostEl!.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLElement>(".wikilink");
      if (!link) return;
      e.preventDefault();
      const name = link.getAttribute("data-doc-name");
      if (!name) return;
      const target = resolveWikilinkTarget(name, get(docsStore));
      if (target) {
        storeSwitchDoc(target.id);
      } else {
        createDoc({ name });
      }
    });
  }

  // initSyncScroll()'s listeners only react to explicit scroll *events* —
  // typing or moving the cursor onto a line that's already visible in the
  // editor's current viewport (so the editor itself never scrolls) never
  // fired them, even when the *preview's* corresponding position was well
  // out of view. Called on every doc change and cursor move; brings the
  // cursor's interpolated position into view only when it isn't already
  // visible, so the preview doesn't jump around on every keystroke while
  // editing something already on screen.
  function followCursorInPreview() {
    const body = document.getElementById("body") as HTMLElement;
    if (!body.classList.contains("mode-split")) return;
    const view = window.MDE.getEditor();
    const preview = hostEl!;
    const cursorPos = view.state.selection.main.head;
    const cursorLine = view.state.doc.lineAt(cursorPos).number - 1;
    const match = previewBlockForLine(preview, cursorLine, view.state.doc.lines);
    if (!match) return;
    const editorRange = editorPixelRangeForLines(match.startLine, match.endLine);
    const cursorEditorTop = view.lineBlockAt(cursorPos).top + editorPaddingTop();
    const targetScrollTop = interpolateAcross(cursorEditorTop, editorRange.top, editorRange.bottom, match.top, match.bottom);
    if (targetScrollTop >= preview.scrollTop && targetScrollTop <= preview.scrollTop + preview.clientHeight) return; // already visible
    syncingScroll = true;
    preview.scrollTop = targetScrollTop;
    requestAnimationFrame(() => { syncingScroll = false; });
  }
```

- [ ] **Step 6: Add `onMount` and the template**

```svelte
  onMount(() => {
    initSyncScroll();
    initWikilinkNavigation();
    // The editor theme flips automatically via CSS keyed off
    // [data-theme] — mermaid can't do that, since it bakes theme into
    // the rendered SVG, so it needs an explicit re-render whenever
    // Settings.svelte's applyTheme() changes documentElement's
    // data-theme.
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

- [ ] **Step 7: Update `client/src/index.html`**

Change (currently `client/index.html:417-419`):

```html
      <section id="previewPane" class="pane">
        <div id="preview"></div>
      </section>
```

to:

```html
      <section id="previewPane" class="pane">
        <div id="preview-mount"></div>
      </section>
```

- [ ] **Step 8: Mount `Preview` in `client/src/main.ts`**

`initSyncScroll()` (Step 4) calls `window.MDE.getEditor()` synchronously
during `Preview.svelte`'s own `onMount` (to attach the scroll listener to
`view.scrollDOM`) — so, same constraint `CommentsPanel.svelte` already
documents in `main.ts`, `Preview` must mount after `Editor` (whose own
mount is what calls `registerEditor()`).

Add the import near `Editor`'s (`client/src/main.ts`):

```typescript
import Editor from "./components/Editor.svelte";
import Preview from "./components/Preview.svelte";
```

Add the mount call right after Editor's own, before CommentsPanel's:

```typescript
mount(Editor, { target: document.getElementById("editor-mount")! });
// Preview.svelte's own onMount calls window.MDE.getEditor() synchronously
// (initSyncScroll attaches a listener to its scrollDOM) — must mount
// after Editor, same constraint CommentsPanel documents below.
mount(Preview, { target: document.getElementById("preview-mount")! });
// CommentsPanel is the first component whose own reactive $effect calls
// window.MDE.getEditor() eagerly (not just from a later click handler,
// like every other window.MDE consumer above) — it must mount after
// Editor, which is what actually calls registerEditor() during its own
// mount, or that first effect run finds cm still null.
mount(CommentsPanel, { target: document.getElementById("comments-panel-mount")! });
```

- [ ] **Step 9: Update `client/src/types.ts`**

Flip `refreshPreview(): void;` and `updatePreview(): void;` (currently
`client/src/types.ts:158` and `:165`) from required to optional, and add
two new optional members. Remove both required lines:

```typescript
  refreshPreview(): void;
```
```typescript
  updatePreview(): void;
```

Add all four to the optional-bridge-methods block (after
`setCommentMarkers?`, `client/src/types.ts:202`):

```typescript
  setCommentMarkers?(entries: { id: string; from: number; to: number }[]): void;
  // Assigned by Preview.svelte's onMount, same reasoning — Phase C
  // moved the render pipeline there. Callers: app.ts's updateListener,
  // its activeIdStore.subscribe, and its bridge's own setDocImage
  // wrapper.
  updatePreview?(): void;
  // Re-runs the full render pipeline — used by DiagramEditor.svelte
  // after editing an existing diagram (doc.diagrams[ref] changes
  // without the document text itself changing, so the normal
  // doc-changed-triggered path never fires on its own).
  refreshPreview?(): void;
  // Assigned by Preview.svelte's onMount. Called from app.ts's
  // updateListener on every docChanged/selectionSet.
  followCursorInPreview?(): void;
  // Assigned by Preview.svelte's onMount. Awaited by app.ts's
  // exportAs() before reading #preview's rendered DOM for txt/html/pdf
  // export, so an in-flight diagram/math render has landed first.
  flushPreviewRenders?(): Promise<void>;
```

- [ ] **Step 10: Delete the moved code from `client/src/app.ts`**

Delete `addDiagramEditButtons()`, `mermaidRenderScheduler`,
`currentMathSources`, `mathRenderScheduler` (`app.ts:91-136` — the full
block from the `addDiagramEditButtons` doc comment through
`mathRenderScheduler`'s closing `}, 400);`).

Delete `init()`'s two calls to the moved init functions (was
`app.ts:155-156`, inside the comment block explaining `cm`'s
already-populated guarantee):

```typescript
    initSyncScroll();
    initWikilinkNavigation();
```

(The surrounding comment about `cm` already being populated stays — it
still correctly explains the guarantee for whatever remains
below it in `init()`, e.g. `initImageUploads()`.)

Change `init()`'s `activeIdStore.subscribe` callback's `updatePreview()`
call (was `app.ts:196`) to `window.MDE.updatePreview?.();` — leave
`updateCounts()` right after it untouched (out of this phase's scope).

Delete the entire sync-scroll section: `syncingScroll`,
`PreviewBlockMatch`, `taggedPreviewBlocks`, `previewBlockForLine`,
`previewBlockForScrollTop`, `editorPaddingTop`,
`editorPixelRangeForLines`, `interpolateAcross`,
`SYNC_SCROLL_END_SLACK_PX`, `initSyncScroll` (was `app.ts:365-560` — the
full block from `let syncingScroll = false;` through `initSyncScroll`'s
closing `}`).

Delete `initWikilinkNavigation()` and `followCursorInPreview()` (was
`app.ts:562-612` — the "---------- Wikilinks ----------" comment through
`followCursorInPreview`'s closing `}`).

Change `buildEditorExtensions()`'s `updateListener` (was `app.ts:326-338`)
from:

```typescript
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave();
          updatePreview();
          updateCounts();
          activeDocContent.set(cm.state.doc.toString());
        }
        if (update.selectionSet) updateCursorPos();
        if (update.docChanged || update.selectionSet) followCursorInPreview();
      }),
```

to:

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
      }),
```

Update the doc comment directly above `buildEditorExtensions()` (was
`app.ts:300-309`) — change:

```typescript
  // Editor.svelte (mounted at #editor-mount) owns the actual EditorView
  // construction/mount/destroy lifecycle, the readOnly/editing-mode/
  // focus-mode/keybindings compartments, the base theme/highlighting
  // extensions, and (as of Phase B of the editor-core migration) the
  // image/comment marker fields, slash-command and wikilink-autocomplete
  // fields, and the Escape keymap that closes their popups — see
  // docs/superpowers/specs/2026-08-19-editor-core-migration-phase-b-design.md.
  // This builds only what app.ts still owns — formatting keymaps, the
  // markdown language, and the save/preview updateListener — which
  // Editor.svelte splices in via window.MDE.getEditorExtensions().
```

to:

```typescript
  // Editor.svelte owns the EditorView itself and the compartments/
  // marker-fields/menu-fields from Phases A/B; Preview.svelte (Phase C)
  // owns the render pipeline, sync-scroll, and wikilink-navigation-in-
  // preview — see docs/superpowers/specs/2026-08-19-editor-core-migration-phase-c-design.md.
  // This builds only what app.ts still owns — formatting keymaps, the
  // markdown language, and the still-mixed-purpose updateListener below
  // (save/counts/doc-content-store stay app.ts's; its two preview calls
  // route through the bridge) — which Editor.svelte splices in via
  // window.MDE.getEditorExtensions().
```

Delete `updatePreview()` itself (was `app.ts:886-1002` — the full
function).

Change the bridge object literal's `refreshPreview()` wrapper (was
`app.ts:1713-1715`) from:

```typescript
    refreshPreview() {
      updatePreview();
    },
```

to nothing — delete it entirely (matches how Phase A/B fully removed
their own moved bridge methods from the literal rather than leaving
stubs; `Preview.svelte`'s `onMount` assigns `window.MDE.refreshPreview`
directly).

Change the bridge's `setDocImage` wrapper (was `app.ts:1723-1726`) from:

```typescript
    setDocImage(key, dataUrl) {
      setDocImage(key, dataUrl);
      updatePreview();
    },
```

to:

```typescript
    setDocImage(key, dataUrl) {
      setDocImage(key, dataUrl);
      window.MDE.updatePreview?.();
    },
```

Delete the direct `updatePreview,` assignment in the bridge literal (was
`app.ts:1731` — this was the required-property assignment; now optional
and assigned by `Preview.svelte` instead).

Delete the theme-change `MutationObserver` (was `app.ts:1677-1683` — the
comment plus the `new MutationObserver(...).observe(...)` statement,
immediately before the bridge literal starts).

Change `exportAs()`'s two flush calls (was `app.ts:1541-1542`) from:

```typescript
    await mermaidRenderScheduler.flush();
    await mathRenderScheduler.flush();
```

to:

```typescript
    await window.MDE.flushPreviewRenders?.();
```

- [ ] **Step 11: Remove now-unused imports from `client/src/app.ts`**

Remove these imports entirely (confirmed via
`grep -n "<symbol>" client/src/app.ts` returning no remaining uses
outside what this task just deleted):

```typescript
import { marked } from "marked";
```
```typescript
import DOMPurify from "dompurify";
```
```typescript
import { mermaidCodeRenderer, mermaidThemeFor, renderMermaidDiagrams } from "./mermaid-preview";
```
```typescript
import { extractMathSpans, renderMathPlaceholders, type MathSource } from "./math-preview";
```
```typescript
import { computeBlockLineStarts, computeListItemLineStarts } from "./scroll-sync";
```
```typescript
import { debounceWithFlush } from "./debounce";
```
```typescript
import { transformWikilinks, resolveWikilinkTarget } from "./wikilinks";
```
```typescript
import markedFootnote from "marked-footnote";
```

Remove the now-obsolete `marked.use(markedFootnote(...))` registration
and its long preceding comment block (`app.ts:57-74`) — moved to
`Preview.svelte` in Step 1.

Remove `docsStore` from the `./stores/docs` import block (confirmed its
only two uses, both inside the code this task just deleted, via
`grep -n "docsStore" client/src/app.ts` before this edit — do NOT remove
`getActiveDoc`, `createDoc`, or `switchDoc as storeSwitchDoc` from that
same import block, all three have other call sites elsewhere in app.ts
that this task doesn't touch).

Leave these imports **unchanged** in app.ts — each has a real remaining
caller outside what this task deletes:
- `get` from `"svelte/store"` (used by `get(workspacesStore)` at three
  other call sites)
- `diagramEditorOpen`, `diagramEditorRef` from `"./stores/diagramEditor"`
  (used by the bridge's `openDiagramEditor()` method)
- `resolveDiagramRefs` from `"./diagram-refs"` (used by `exportAs()`'s
  markdown branch and `getResolvedContent()`)
- `katexCss` (used by `exportAs()`'s HTML export)

- [ ] **Step 12: Type-check and verify**

```bash
cd client && npx tsc --noEmit
```

Expected: clean. If you see an unresolved-reference error inside app.ts
for anything preview/sync-scroll/wikilink-nav-related, you missed a
deletion or a call-site update — cross-check against
`grep -n "updatePreview\|currentMathSources\|syncingScroll\|previewBlockFor\|initSyncScroll\|initWikilinkNavigation\|followCursorInPreview\|mermaidRenderScheduler\|mathRenderScheduler" client/src/app.ts`,
which should return nothing except the two `window.MDE.updatePreview?.()`
call sites, the one `window.MDE.followCursorInPreview?.()` call site, and
the one `window.MDE.flushPreviewRenders?.()` call site from Step 10.

```bash
npx svelte-check --tsconfig ./tsconfig.json
```

Expected: `0 ERRORS 0 WARNINGS`.

```bash
cd .. && npm test 2>&1 | tail -10
```

Expected: all existing 473 tests pass (this phase adds no new tests).

- [ ] **Step 13: Live-verify**

Start the dev server and seed `localStorage` with a test document (same
technique used for Phases A/B — see
`docs/superpowers/plans/2026-08-19-editor-core-migration-phase-a.md`'s
own live-verification step for the exact seeding shape), then via
browser automation:

```bash
cd client && npm run dev -- --port 5271
```

1. **Live rendering**: type markdown covering a heading, a ` ```mermaid `
   fence with a trivial diagram (e.g. `graph TD; A-->B;`), a `$x^2$`
   math span, a `[[Wikilink]]`, and a footnote reference (`text[^1]` /
   `[^1]: note`); confirm the preview pane renders all of them correctly
   (diagram as SVG, math via KaTeX, wikilink as a styled link, footnote
   with a linked reference) and updates on every keystroke.
2. **Sync-scroll**: switch to split view; scroll the editor pane and
   confirm the preview follows; scroll the preview pane and confirm the
   editor follows back; switch out of split view and confirm neither
   pane's scroll affects the other anymore (the `mode-split` gate).
3. **Wikilink navigation**: click an existing `[[wikilink]]` in the
   rendered preview (seed a second document matching the link target
   first), confirm it switches documents; click a link to a
   non-existent name, confirm it creates a new document with that name.
4. **Cursor-follow**: with a long-enough document that the target line
   isn't already visible in the preview, move the cursor there via arrow
   keys (not a click, which wouldn't scroll the editor itself) and
   confirm the preview scrolls to follow.
5. **Diagram edit-in-place**: open the mermaid diagram via
   `DiagramEditor.svelte` (click its "Edit" button, added by
   `addDiagramEditButtons`), change it, save, and confirm the preview
   reflects the change without needing a further keystroke in the main
   editor.
6. **Theme toggle**: switch light/dark via Settings, confirm the mermaid
   diagram visibly re-renders in the new theme's colors.
7. **Export**: with the mermaid-diagram document active, run `txt`,
   `html`, and `pdf` export (via the Export menu) and confirm each
   succeeds and the diagram appears fully rendered (not raw fence
   source) in the html/pdf output — this exercises
   `window.MDE.flushPreviewRenders?.()`.
8. **Regression spot-check**: re-run a quick version of Phases A/B's own
   live-verification — vim mode's status indicator, focus mode's body
   class toggle, comment marker highlighting, and slash/wikilink editor
   triggers (Escape closing them) — cheap given the shared dev-server
   setup, and this phase's `buildEditorExtensions()` doc-comment edit
   touches the same function those rely on.

Stop the dev server when done.

- [ ] **Step 14: Commit**

```bash
git add client/src/components/Preview.svelte client/src/app.ts client/src/types.ts client/index.html client/src/main.ts
git commit -m "$(cat <<'EOF'
feat: move the preview render pipeline, sync-scroll, and wikilink navigation into Preview.svelte

Phase C of the editor-core migration: updatePreview() (the full marked/
DOMPurify/mermaid/math render pipeline), sync-scroll, wikilink
navigation-in-preview, follow-cursor, and the two render schedulers
move from app.ts into a new Preview.svelte, mounted at a new
#preview-mount div (the inner rendered-content div keeps id="preview"
unchanged, so existing CSS and app.ts's own remaining
getElementById("preview") reads — exportAs(), updateMainView() — keep
working).

window.MDE.updatePreview/refreshPreview flip from required to
optional, assigned at mount. New optional followCursorInPreview and
flushPreviewRenders bridge methods replace app.ts's direct calls into
the moved closure functions/schedulers. app.ts's updateListener keeps
its non-preview responsibilities (save, counts, doc-content store)
and calls through the bridge for its two preview-related ones.

Live-verified: live rendering (mermaid/math/wikilink/footnote),
sync-scroll both directions plus the mode-split gate, wikilink
click-navigation (existing and new-doc-creation paths), cursor-follow,
diagram edit-in-place refresh, theme-triggered mermaid re-render,
txt/html/pdf export with a rendered diagram, plus a Phase A/B
regression spot-check.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-plan note

Same category of gap Phases A/B flagged: this plan's live-verification
covers the local (non-collab) path only. Nothing here exercises how
`Preview.svelte`'s render pipeline behaves against a collaboratively-
edited document synced via `collab.ts` — the render pipeline itself
reads `window.MDE.getEditor().state.doc`, which is collab-agnostic (it
doesn't care whether the content arrived via local typing or a Yjs sync),
so no new risk is expected, but this hasn't been runtime-verified against
a real shared room (`wrangler dev`), consistent with every prior phase's
own scope limits.

## Self-review

- **Spec coverage**: every Goals-section item in the Phase C design spec
  has a task — `escape-html.ts` extraction (Task 1),
  `Preview.svelte`/render-pipeline/sync-scroll/wikilink-nav/follow-cursor/
  schedulers (Task 2, Steps 1-6), the mount-point decision (Task 2, Steps
  7-8), all four bridge-method changes (Task 2, Step 9), the
  updateListener split and every real caller found in the design spec's
  own research (Task 2, Step 10). The spec's Non-goals (status bar,
  export content-resolution, view-mode toggle, save pipeline) are
  explicitly left untouched — confirmed by name in Step 11's "leave
  unchanged" list and Step 10's updateListener diff, which keeps
  `updateCounts()`/`updateCursorPos()`/`scheduleSave()`/
  `activeDocContent.set(...)` exactly where they were.
- **Placeholder scan**: none — every step's code block is the actual
  verbatim content (read directly from the current worktree state
  immediately before writing this plan) or an exact diff.
- **Type consistency**: `updatePreview(): void`, `refreshPreview(): void`,
  `followCursorInPreview(): void`, `flushPreviewRenders(): Promise<void>`
  match between Task 2's `Preview.svelte` implementation (Steps 2, 6),
  its `types.ts` declarations (Step 9), and every call site updated in
  Step 10 — including the `Promise<void>`/`await` shape for
  `flushPreviewRenders`, which is the one method with a non-`void`
  return, verified consistent across its `onMount` assignment (an
  `async () => { ... }` arrow function) and its `exportAs()` caller
  (`await window.MDE.flushPreviewRenders?.();`).
- **Task boundaries**: Task 1 is fully independent and net-neutral (pure
  function relocation, zero behavior surface). Task 2 is deliberately one
  atomic task rather than split further — `previewBlockForLine`/
  `editorPixelRangeForLines`/`interpolateAcross` are shared between
  sync-scroll and follow-cursor, and `currentMathSources` couples
  `updatePreview()` to the math scheduler, so no sub-boundary within Task
  2 would leave a compilable, independently-reviewable intermediate
  state — the same reasoning Phase A applied to its own compartments/
  keybindings/focus-mode task.
