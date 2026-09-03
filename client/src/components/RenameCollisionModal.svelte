<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { renameCollision } from "../stores/renameCollision";
  import { docsStore, removeDocById } from "../stores/docs";
  import { ensureUniqueName } from "../doc-naming";

  // Computed live so the button label always reflects the current
  // document list, not a stale snapshot from when the modal opened.
  const suggestedName = $derived(
    $renameCollision ? ensureUniqueName($renameCollision.pendingName, $docsStore, $renameCollision.docId) : "",
  );

  function titleInput() {
    return document.getElementById("docTitle") as HTMLInputElement;
  }

  // Sets the field's value and re-dispatches "input" so app.ts's own
  // existing handler does the rest (renameDoc + scheduleSave +
  // resizeDocTitle + updatePageTitle) — reusing that path instead of
  // duplicating its four side effects here, and guaranteeing the final
  // name is scheduled for a real save regardless of the debounce timer's
  // state at blur time.
  function commitName(name: string) {
    const input = titleInput();
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    renameCollision.set(null);
  }

  function replace() {
    const state = $renameCollision;
    if (!state) return;
    removeDocById(state.collidingDocId);
    commitName(state.pendingName);
    void window.MDE.cascadeWikilinkRenameAndToast(state.docId, state.previousName, state.pendingName);
  }

  function saveAsSuffixed() {
    const state = $renameCollision;
    if (!state) return;
    const finalName = suggestedName;
    commitName(finalName);
    void window.MDE.cascadeWikilinkRenameAndToast(state.docId, state.previousName, finalName);
  }

  function cancel() {
    const state = $renameCollision;
    if (!state) return;
    commitName(state.previousName);
  }

  onMount(() => {
    // Matches every other Svelte modal's own Escape handling (app.ts's
    // generic handler skips [data-svelte-modal] elements) — this one was
    // missing it entirely before this conversion.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $renameCollision) cancel();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $renameCollision}
  <Modal title="Name already in use" elevated labelledBy="renameCollisionTitle" onClose={cancel}>
    <p>Another document is already named "{$renameCollision.pendingName}".</p>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
      <button type="button" class="secondary-btn" onclick={saveAsSuffixed}>Save as "{suggestedName}"</button>
      <button type="button" class="secondary-btn danger-btn" onclick={replace}>Replace</button>
    {/snippet}
  </Modal>
{/if}
