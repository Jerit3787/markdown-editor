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

  let codeHostEl: HTMLDivElement | undefined = $state();
  let previewEl: HTMLDivElement | undefined = $state();
  let codeView: EditorView | undefined;
  let hasCode = $state(false);

  const renderScheduler = debounceWithFlush(() => {
    if (!previewEl || !codeView) return;
    const code = codeView.state.doc.toString();
    if (!code.trim()) {
      previewEl.innerHTML = "";
      return;
    }
    previewEl.innerHTML = '<pre class="mermaid"></pre>';
    const block = previewEl.querySelector(".mermaid")!;
    block.textContent = code;
    const theme = mermaidThemeFor(document.documentElement.getAttribute("data-theme"));
    return renderMermaidDiagrams(previewEl, theme);
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
    renderScheduler.trigger();
    return () => {
      codeView?.destroy();
      codeView = undefined;
    };
  });

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
      // text (which only ever held the ref, not the source) is untouched.
      setDocDiagram(ref, code);
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
      if (e.key === "Escape" && $diagramEditorOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $diagramEditorOpen}
  <div class="diagram-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="diagramEditorTitle">
    <div class="diagram-editor-header">
      <h2 id="diagramEditorTitle">{$diagramEditorRef ? "Edit diagram" : "New diagram"}</h2>
      <button type="button" class="secondary-btn" onclick={close}>Cancel</button>
      <button type="button" class="primary-btn" disabled={!hasCode} onclick={save}>Save</button>
    </div>
    <div class="diagram-editor-body">
      <div class="diagram-editor-code-host" bind:this={codeHostEl}></div>
      <div class="diagram-editor-preview" bind:this={previewEl}></div>
    </div>
  </div>
{/if}
