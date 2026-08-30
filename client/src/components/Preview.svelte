<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import markedFootnote from "marked-footnote";
  import { get } from "svelte/store";
  import { getActiveDoc, docsStore, switchDoc as storeSwitchDoc, createDoc } from "../stores/docs";
  import { mermaidCodeRenderer, mermaidThemeFor, renderMermaidDiagrams } from "../mermaid-preview";
  import { extractMathSpans, renderMathPlaceholders, type MathSource } from "../math-preview";
  import { computeBlockLineStarts, computeListItemLineStarts } from "../scroll-sync";
  import { resolveWikilinkTarget, transformWikilinks } from "../wikilinks";
  import { transformDefinitionLists, transformSuperscriptSubscript } from "../mmd-inline-blocks";
  import { transformCitations, DEFAULT_CITATION_PREFS } from "../mmd-citations";
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
  let activeDocTitle = $state("");
  let syncingScroll = false;
  let currentMathSources: Map<string, MathSource> = new Map();

  function updatePreview() {
    const view = window.MDE.getEditor();
    const raw = view.state.doc.toString();
    const doc = getActiveDoc();
    activeDocTitle = doc?.name ?? "";
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
    const withInlineBlocks = transformSuperscriptSubscript(transformDefinitionLists(extractedRaw));
    const citationPrefs = doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS;
    const withCitations = transformCitations(withInlineBlocks, citationPrefs, doc?.citations?.bibliography ?? []);
    const html = marked.parse(withCitations, { gfm: true, breaks: false, renderer }) as string;
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

  // ---------- Sync-scroll ----------
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

  // ---------- Wikilinks ----------
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

  // Split mode stacks the two panes vertically below this width (see
  // #body.mode-split #main in _layout.scss) instead of placing them side
  // by side, roughly halving each pane's own clientHeight — which makes
  // followCursorInPreview()'s "already visible" window (below) far
  // narrower, so a cursor move is much more likely to force a jump.
  // Combined with mobile text editors commonly registering a fast
  // scroll-then-release touch gesture as a tap that plants the cursor at
  // the release point, this made the preview snap to wherever the cursor
  // last happened to be (confirmed live: scrolling the preview elsewhere,
  // then moving the cursor with no editor scroll involved at all, forced
  // the preview back by thousands of pixels) — not a scroll-sync bug at
  // all, since initSyncScroll's own listeners (above) were never involved.
  // Same breakpoint app.ts's own isMobile() uses. Checked live on each
  // call rather than cached, so rotating a device or resizing past the
  // breakpoint takes effect immediately.
  function panesAreSideBySide(): boolean {
    return !window.matchMedia("(max-width: 780px)").matches;
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
    if (!body.classList.contains("mode-split") || !panesAreSideBySide()) return;
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

<h1 id="printDocTitle" class="print-only">{activeDocTitle}</h1>
<div id="preview-mount">
  <div bind:this={hostEl} id="preview"></div>
</div>
