<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView } from "@codemirror/view";

  let hostEl: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;

  onMount(() => {
    // app.ts owns the actual extension list (formatting commands, save/
    // preview/count callbacks, the collab/readOnly compartments, image
    // upload handling — none of that is a DOM-mounting concern) — this
    // component's job is just the EditorView's real lifecycle: create it
    // against this host element, destroy it on unmount. window.MDE
    // already exists by the time this runs (app.ts assigns it at module
    // top-level, which finishes before main.ts's mount() calls that
    // trigger this onMount).
    view = new EditorView({
      doc: "",
      parent: hostEl,
      extensions: window.MDE.getEditorExtensions(),
    });
    window.MDE.registerEditor(view);
  });

  onDestroy(() => {
    view?.destroy();
  });
</script>

<div id="editorWrap">
  <div bind:this={hostEl} class="cm-host"></div>
</div>
