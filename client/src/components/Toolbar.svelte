<script lang="ts">
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { viewMode, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane } from "../stores/view";

  function run(cmd: string) {
    window.MDE.runCmd(cmd);
    window.MDE.getEditor().focus();
  }

  const editorOn = $derived(isEditorOn($viewMode));
  const previewOn = $derived(isPreviewOn($viewMode));
</script>

<div id="toolbar">
  <div class="toolbar-buttons">
    <!-- Shown only while the sidebar is collapsed — sits inline with the
         formatting tools instead of floating over the editor. Wired by
         app.ts's initSidebar(), same as before — this component only owns
         the markup/id, not the click behavior, since sidebar state lives
         there. -->
    <button id="sidebarToggleOut" class="icon-btn" title="Show documents panel" aria-label="Show documents panel" hidden><svg class="icon"><use href="#icon-menu"></use></svg></button>
    <span class="sep" id="sidebarToggleOutSep" hidden></span>
    <button type="button" title="Bold (Ctrl+B)" onclick={() => run("bold")}><b>B</b></button>
    <button type="button" title="Italic (Ctrl+I)" onclick={() => run("italic")}><i>I</i></button>
    <button type="button" title="Strikethrough" onclick={() => run("strike")}><svg class="icon"><use href="#icon-strikethrough"></use></svg></button>
    <span class="sep"></span>
    <button type="button" title="Heading 1" onclick={() => run("h1")}>H1</button>
    <button type="button" title="Heading 2" onclick={() => run("h2")}>H2</button>
    <button type="button" title="Heading 3" onclick={() => run("h3")}>H3</button>
    <span class="sep"></span>
    <button type="button" title="Blockquote" onclick={() => run("quote")}><svg class="icon"><use href="#icon-quote"></use></svg></button>
    <button type="button" title="Inline code" onclick={() => run("code")}><svg class="icon"><use href="#icon-code"></use></svg></button>
    <button type="button" title="Code block" onclick={() => run("codeblock")}><svg class="icon"><use href="#icon-braces"></use></svg></button>
    <span class="sep"></span>
    <button type="button" title="Bullet list" onclick={() => run("ul")}><svg class="icon"><use href="#icon-list"></use></svg></button>
    <button type="button" title="Numbered list" onclick={() => run("ol")}><svg class="icon"><use href="#icon-list-ordered"></use></svg></button>
    <button type="button" title="Task list" onclick={() => run("task")}><svg class="icon"><use href="#icon-square-check"></use></svg></button>
    <span class="sep"></span>
    <button type="button" title="Link (Ctrl+K)" onclick={() => run("link")}><svg class="icon"><use href="#icon-link"></use></svg></button>
    <button type="button" title="Image" onclick={() => run("image")}><svg class="icon"><use href="#icon-image"></use></svg></button>
    <!-- Wired by app.ts's initImagesManager(), same as before. -->
    <button id="imagesManagerBtn" type="button" title="Manage images"><svg class="icon"><use href="#icon-images"></use></svg></button>
    <button type="button" title="Table" onclick={() => run("table")}><svg class="icon"><use href="#icon-table"></use></svg></button>
    <button type="button" title="Horizontal rule" onclick={() => run("hr")}>―</button>
    <button type="button" title="Insert diagram" onclick={() => { diagramEditorRef.set(null); diagramEditorOpen.set(true); }}><svg class="icon"><use href="#icon-workflow"></use></svg></button>
    <!-- A text glyph, not an SVG icon — matches the existing H1/H2/H3 and
         ― buttons in this same toolbar, which use plain text rather than
         inventing a new icon sprite entry. -->
    <button type="button" title="Math" onclick={() => run("math")}>&Sigma;</button>
    <button type="button" title="Footnote" onclick={() => run("footnote")}>[^]</button>
  </div>

  <span class="spacer"></span>

  <div class="view-selector" role="group" aria-label="View mode">
    <button type="button" class:active={editorOn} title="Toggle editor pane" aria-label="Toggle editor pane" aria-pressed={editorOn} onclick={toggleEditorPane}>
      <svg class="icon"><use href="#icon-file"></use></svg>
    </button>
    <button type="button" class:active={previewOn} title="Toggle preview pane" aria-label="Toggle preview pane" aria-pressed={previewOn} onclick={togglePreviewPane}>
      <svg class="icon"><use href="#icon-panel-right"></use></svg>
    </button>
  </div>
</div>
