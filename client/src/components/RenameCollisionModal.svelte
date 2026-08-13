<script lang="ts">
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
  }

  function saveAsSuffixed() {
    if (!$renameCollision) return;
    commitName(suggestedName);
  }

  function cancel() {
    const state = $renameCollision;
    if (!state) return;
    commitName(state.previousName);
  }
</script>

{#if $renameCollision}
  <div class="modal-backdrop" data-svelte-modal>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="renameCollisionTitle">
      <h2 id="renameCollisionTitle">Name already in use</h2>
      <p>Another document is already named "{$renameCollision.pendingName}".</p>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
        <button type="button" class="secondary-btn" onclick={saveAsSuffixed}>Save as "{suggestedName}"</button>
        <button type="button" class="secondary-btn danger-btn" onclick={replace}>Replace</button>
      </div>
    </div>
  </div>
{/if}
