<script lang="ts">
  import { onMount } from "svelte";
  import { EditorState } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { getActiveDoc, setDocDiagram } from "../stores/docs";
  import { diagramKey } from "../diagram-refs";
  import { renderMermaidDiagrams, mermaidThemeFor } from "../mermaid-preview";
  import { debounceWithFlush } from "../debounce";
  import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
  import { showToast } from "../stores/toast";
  import { svgOuterHtmlForExport, pngBlobFromSvg } from "../diagram-export";
  import { syntaxHighlighting } from "@codemirror/language";
  import { mermaidStreamLanguage, mermaidHighlightStyle } from "../mermaid-language";

  const TEMPLATES: { name: string; code: string }[] = [
    { name: "Flowchart", code: "flowchart TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Do the thing]\n    B -->|No| D[Skip it]" },
    { name: "Sequence", code: "sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello Bob\n    B-->>A: Hi Alice" },
    { name: "Class", code: "classDiagram\n    class Animal {\n      +String name\n      +makeSound()\n    }\n    Animal <|-- Dog" },
    { name: "State", code: "stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running : start\n    Running --> Idle : stop" },
    { name: "ER", code: "erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ LINE_ITEM : contains" },
    { name: "Gantt", code: "gantt\n    title Project Plan\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Task A :a1, 2026-01-01, 5d\n    Task B :after a1, 3d" },
    { name: "Pie", code: "pie title Survey Results\n    \"Yes\" : 60\n    \"No\" : 30\n    \"Unsure\" : 10" },
  ];

  let codeHostEl: HTMLDivElement | undefined = $state();
  let previewEl: HTMLDivElement | undefined = $state();
  let codeView: EditorView | undefined;
  let hasCode = $state(false);
  let showPicker = $state(false);
  let showReference = $state(false);

  let panzoomInstance: PanzoomObject | undefined;
  let lastRenderedSvg: SVGSVGElement | null = $state(null);

  function destroyPanzoom() {
    if (!panzoomInstance) return;
    previewEl?.removeEventListener("wheel", panzoomInstance.zoomWithWheel);
    panzoomInstance.destroy();
    panzoomInstance = undefined;
  }

  function setupPanzoom(svg: SVGSVGElement) {
    destroyPanzoom();
    // Panzoom defaults to setting overflow:hidden on the target's own
    // *immediate* parent (assuming that parent is the intended viewport).
    // Here that's the mermaid-rendered <pre>, which is sized to the SVG's
    // natural unscaled dimensions — not .diagram-editor-preview, the
    // actual (correctly-sized) viewport two levels up. Left at the
    // default, the <pre> clips the transformed SVG before it ever reaches
    // .diagram-editor-preview's own overflow:hidden, which is the
    // boundary we actually want in effect.
    panzoomInstance = Panzoom(svg, { maxScale: 5, overflow: "visible" });
    previewEl?.addEventListener("wheel", panzoomInstance.zoomWithWheel);
  }

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Panzoom has no built-in "fit to container" — a diagram taller than the
  // preview pane renders at native (scale-1) size and gets silently
  // clipped by the pane's overflow:hidden, with no scrollbar or other cue
  // that content is missing. Shrinks (never enlarges) and centers the
  // diagram so the whole thing is always visible on first render and after
  // "Reset view", measuring actual rects rather than assuming Panzoom's
  // internal transform math, since that's undocumented.
  //
  // Panzoom's .zoom()/.pan() always defer the real style write to a
  // requestAnimationFrame callback (see setTransformWithEvent in its
  // source) — getBoundingClientRect() called synchronously right after
  // either one reads the *previous* transform, not the one just set. Each
  // step below must wait a real frame before measuring the result of the
  // previous one.
  async function fitToContainer() {
    if (!panzoomInstance || !previewEl || !lastRenderedSvg) return;
    const svg = lastRenderedSvg;
    panzoomInstance.zoom(1, { animate: false, force: true });
    panzoomInstance.pan(0, 0, { animate: false, force: true });
    await nextFrame();
    // A newer render pass may have swapped panzoomInstance/lastRenderedSvg
    // out from under this in-flight call while it was awaiting the frame.
    if (panzoomInstance === undefined || lastRenderedSvg !== svg) return;
    const containerRect = previewEl.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0 || svgRect.height === 0) return;
    // 0.92 leaves a small margin so the diagram doesn't touch the pane's
    // padding edge at full fit.
    const scale = Math.min(1, (containerRect.width / svgRect.width) * 0.92, (containerRect.height / svgRect.height) * 0.92);
    panzoomInstance.zoom(scale, { animate: false, force: true });
    await nextFrame();
    if (panzoomInstance === undefined || lastRenderedSvg !== svg) return;
    const scaledRect = svg.getBoundingClientRect();
    const dx = (containerRect.width - scaledRect.width) / 2 - (scaledRect.left - containerRect.left);
    const dy = (containerRect.height - scaledRect.height) / 2 - (scaledRect.top - containerRect.top);
    panzoomInstance.pan(dx / scale, dy / scale, { relative: true, animate: false, force: true });
  }

  function resetView() {
    fitToContainer();
  }

  let showExportMenu = $state(false);

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportFilename(ext: string): string {
    return `${$diagramEditorRef || "diagram"}.${ext}`;
  }

  async function copyAsSvg() {
    if (!lastRenderedSvg) return;
    showExportMenu = false;
    try {
      await navigator.clipboard.writeText(svgOuterHtmlForExport(lastRenderedSvg));
      showToast("Copied as SVG", "success");
    } catch {
      showToast("Couldn't copy — clipboard access was blocked", "error");
    }
  }

  async function downloadPng() {
    if (!lastRenderedSvg) return;
    showExportMenu = false;
    try {
      const blob = await pngBlobFromSvg(lastRenderedSvg);
      downloadBlob(blob, exportFilename("png"));
    } catch {
      showToast("Couldn't generate the PNG", "error");
    }
  }

  const renderScheduler = debounceWithFlush(async () => {
    if (!previewEl || !codeView) return;
    const code = codeView.state.doc.toString();
    if (!code.trim()) {
      previewEl.innerHTML = "";
      lastRenderedSvg = null;
      destroyPanzoom();
      return;
    }
    previewEl.innerHTML = '<pre class="mermaid"></pre>';
    const block = previewEl.querySelector(".mermaid")!;
    block.textContent = code;
    const theme = mermaidThemeFor(document.documentElement.getAttribute("data-theme"));
    await renderMermaidDiagrams(previewEl, theme);
    const svg = previewEl.querySelector("svg");
    if (svg instanceof SVGSVGElement) {
      lastRenderedSvg = svg;
      setupPanzoom(svg);
      await fitToContainer();
    } else {
      lastRenderedSvg = null;
      destroyPanzoom();
    }
  }, 300);

  function buildCodeView(initialDoc: string): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          mermaidStreamLanguage,
          syntaxHighlighting(mermaidHighlightStyle),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            hasCode = update.state.doc.length > 0;
            renderScheduler.trigger();
          }),
        ],
      }),
      parent: codeHostEl,
    });
  }

  // Runs whenever the editor opens (for either create or edit) — mounts a
  // fresh CodeMirror instance seeded with the right starting content.
  $effect(() => {
    if (!$diagramEditorOpen || !codeHostEl) return;
    const ref = $diagramEditorRef;
    const doc = getActiveDoc();
    const initialCode = ref && doc?.diagrams ? doc.diagrams[ref] || "" : "";
    codeView = buildCodeView(initialCode);
    hasCode = initialCode.length > 0;
    showPicker = !ref; // creating new: start on the template picker
    renderScheduler.trigger();
    return () => {
      codeView?.destroy();
      codeView = undefined;
      destroyPanzoom();
      lastRenderedSvg = null;
    };
  });

  function pickTemplate(code: string) {
    showPicker = false;
    codeView?.dispatch({ changes: { from: 0, to: codeView.state.doc.length, insert: code } });
    codeView?.focus();
  }

  function startBlank() {
    showPicker = false;
    codeView?.focus();
  }

  function close() {
    diagramEditorOpen.set(false);
    diagramEditorRef.set(null);
  }

  function save() {
    if (!codeView) return;
    const code = codeView.state.doc.toString();
    if (!code.trim()) return;
    const doc = getActiveDoc();
    const ref = $diagramEditorRef;
    if (ref) {
      // Editing: overwrite the existing ref's stored source. The document
      // text (which only ever held the ref, not the source) is untouched
      // — so the main preview's normal re-render-on-doc-change never
      // fires on its own; force it explicitly.
      setDocDiagram(ref, code);
      window.MDE.refreshPreview();
    } else {
      // Creating: mint a new ref, store the source, then insert a fence
      // referencing it at the cursor.
      const key = diagramKey((doc && doc.diagrams) || {});
      setDocDiagram(key, code);
      window.MDE.insertAtCursor(`\n\`\`\`mermaid\n${key}\n\`\`\`\n`);
    }
    close();
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showExportMenu) { showExportMenu = false; return; }
      if ($diagramEditorOpen) close();
    };
    const onDocClick = (e: MouseEvent) => {
      if (showExportMenu && !(e.target as Element).closest(".dropdown")) showExportMenu = false;
    };
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("click", onDocClick);
    return () => {
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("click", onDocClick);
    };
  });
</script>

{#if $diagramEditorOpen}
  <div class="diagram-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="diagramEditorTitle">
    <div class="diagram-editor-header">
      <h2 id="diagramEditorTitle">{$diagramEditorRef ? "Edit diagram" : "New diagram"}</h2>
      <button type="button" class="secondary-btn" onclick={() => (showReference = !showReference)}>
        {showReference ? "Hide reference" : "Syntax reference"}
      </button>
      <div class="dropdown">
        <button type="button" class="secondary-btn" disabled={!lastRenderedSvg} onclick={() => (showExportMenu = !showExportMenu)}>
          Export
        </button>
        <div class="dropdown-menu" class:open={showExportMenu}>
          <button type="button" onclick={copyAsSvg}>Copy as SVG</button>
          <button type="button" onclick={downloadPng}>Download PNG</button>
        </div>
      </div>
      <button type="button" class="secondary-btn" onclick={close}>Cancel</button>
      <button type="button" class="primary-btn" disabled={!hasCode} onclick={save}>Save</button>
    </div>
    <div class="diagram-editor-body" class:with-reference={showReference}>
      <div class="diagram-editor-code-host" bind:this={codeHostEl}></div>
      <div class="diagram-editor-preview-wrap">
        <div class="diagram-editor-preview" bind:this={previewEl}></div>
        {#if lastRenderedSvg}
          <button type="button" class="diagram-preview-reset" onclick={resetView}>Reset view</button>
        {/if}
      </div>
      {#if showReference}
        <div class="diagram-editor-reference">
          <h3>Flowchart</h3>
          <p><code>A[Rectangle]</code> · <code>A(Rounded)</code> · <code>A{"{Diamond}"}</code></p>
          <p><code>A --&gt; B</code> arrow · <code>A -.-&gt; B</code> dotted · <code>A --&gt;|Label| B</code> labeled</p>
          {#each TEMPLATES as t (t.name)}
            <h3>{t.name}</h3>
            <pre>{t.code}</pre>
          {/each}
        </div>
      {/if}
    </div>
    {#if showPicker}
      <div class="diagram-template-picker">
        <p>Start from a template</p>
        <div class="diagram-template-grid">
          {#each TEMPLATES as t (t.name)}
            <button type="button" class="diagram-template-card" onclick={() => pickTemplate(t.code)}>{t.name}</button>
          {/each}
        </div>
        <p class="diagram-template-or">or <button type="button" class="secondary-btn" onclick={startBlank}>start new</button></p>
      </div>
    {/if}
  </div>
{/if}
