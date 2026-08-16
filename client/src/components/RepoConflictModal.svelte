<script lang="ts">
  import Modal from "./Modal.svelte";
  import { repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { showToast } from "../stores/toast";

  let choices = $state<Record<string, "mine" | "theirs">>({});
  let busy = $state(false);

  $effect(() => {
    if ($repoConflictState) {
      choices = Object.fromEntries($repoConflictState.conflicts.map((c) => [c.docId, "mine" as const]));
    }
  });

  function close() {
    repoConflictModalOpen.set(false);
    repoConflictState.set(null);
  }

  async function confirm() {
    const state = $repoConflictState;
    if (!state) return;
    busy = true;
    try {
      await state.onResolve(choices);
      showToast(state.kind === "pull" ? "Pull complete" : "Push complete", "success");
      close();
    } catch (err: any) {
      showToast(err.message || "Failed to resolve conflicts", "error");
    } finally {
      busy = false;
    }
  }
</script>

{#if $repoConflictModalOpen && $repoConflictState}
  <Modal title={$repoConflictState.kind === "pull" ? "Resolve Pull Conflicts" : "Resolve Push Conflicts"} icon="icon-github" wide labelledBy="repoConflictModalTitle" onClose={close}>
    {#if $repoConflictState.conflicts.length > 0}
      <div class="menu-section-label">Changed on both sides</div>
      {#each $repoConflictState.conflicts as conflict (conflict.docId)}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{conflict.docName}</div>
            <div class="gist-date">{conflict.repoPath}</div>
          </div>
          <select bind:value={choices[conflict.docId]} aria-label={`Resolution for ${conflict.docName}`}>
            <option value="mine">Keep mine</option>
            <option value="theirs">Take theirs</option>
          </select>
        </div>
      {/each}
    {/if}
    {#if $repoConflictState.deletions.length > 0}
      <div class="menu-section-label">Will be removed</div>
      {#each $repoConflictState.deletions as del (del.docId)}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{del.docName}</div>
            <div class="gist-date">{del.repoPath}</div>
          </div>
        </div>
      {/each}
    {/if}
    <div class="modal-actions">
      <button class="secondary-btn" type="button" onclick={close} disabled={busy}>Cancel</button>
      <button class="primary-btn" type="button" onclick={confirm} disabled={busy}>{busy ? "Applying…" : "Apply"}</button>
    </div>
  </Modal>
{/if}
