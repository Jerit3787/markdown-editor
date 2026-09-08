<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import Modal from "./Modal.svelte";
  import { requestAccessModalOpen } from "../stores/share";
  import { requestAccessFromOwner } from "../collab";
  import { workspacesStore, activeWorkspaceIdStore } from "../stores/workspaces";
  import { showToast } from "../stores/toast";

  let note = $state("");
  let sending = $state(false);

  function remoteId(): string | null {
    const ws = get(workspacesStore).find((w) => w.id === get(activeWorkspaceIdStore));
    return ws?.remoteId ?? null;
  }

  function close() {
    requestAccessModalOpen.set(false);
    note = "";
  }

  async function send() {
    const id = remoteId();
    if (!id || sending) return;
    sending = true;
    const ok = await requestAccessFromOwner(id, note.trim());
    sending = false;
    if (ok) {
      close();
      showToast("Request sent to the owner", "info");
    } else {
      showToast("Couldn't send the request", "error");
    }
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $requestAccessModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $requestAccessModalOpen}
  <Modal title="Request edit access" labelledBy="requestAccessTitle" maxWidth="420px" onClose={close}>
    <p class="modal-hint" id="requestAccessTitle">
      Ask the workspace owner to let you edit this document. They'll see your request in the Share dialog.
    </p>
    <textarea
      class="request-access-note"
      aria-label="Add a note to the owner (optional)"
      placeholder="Add a note to the owner (optional)"
      rows="3"
      bind:value={note}
    ></textarea>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={close}>Cancel</button>
      <button type="button" class="primary-btn" onclick={send} disabled={sending}>Send request</button>
    {/snippet}
  </Modal>
{/if}
