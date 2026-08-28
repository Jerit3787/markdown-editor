<script lang="ts">
  import Modal from "./Modal.svelte";
  import { gistVisibilityRequest } from "../stores/gistVisibilityDialog";

  let choice = $state<"secret" | "public">("secret");

  function respond(visibility: "public" | "secret" | null) {
    $gistVisibilityRequest?.resolve(visibility);
    gistVisibilityRequest.set(null);
    choice = "secret";
  }
</script>

{#if $gistVisibilityRequest}
  <Modal title="Publish to Gist" icon="icon-rocket" labelledBy="gistVisibilityTitle" onClose={() => respond(null)}>
    <div class="empty-state" style="padding: 12px 0 24px;">
      <svg class="empty-state-icon"><use href="#icon-info"></use></svg>
      <label for="gistVisibilitySelect" class="menu-section-label" style="margin-top: 16px;">Visibility</label>
      <select id="gistVisibilitySelect" bind:value={choice}>
        <option value="secret">Secret</option>
        <option value="public">Public</option>
      </select>
      <div class="empty-state-desc" style="margin-top: 12px;">
        Secret gists aren't listed publicly, but anyone with the link can view them. Public gists are listed on your GitHub profile and
        discoverable by anyone. <strong>This can't be changed after publishing</strong> — GitHub has no way to convert a gist's
        visibility once it's created.
      </div>
    </div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={() => respond(null)}>Cancel</button>
      <button type="button" class="primary-btn" onclick={() => respond(choice)}>Publish</button>
    {/snippet}
  </Modal>
{/if}
