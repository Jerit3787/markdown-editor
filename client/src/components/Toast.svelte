<script lang="ts">
  import { toasts, dismissToast } from "../stores/toast";
</script>

<div class="toast-stack" aria-live="polite">
  {#each $toasts as t (t.id)}
    <div class="toast toast-{t.type}" role="status">
      <span class="toast-message">{t.message}</span>
      <button type="button" class="toast-close" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>
        <svg class="icon"><use href="#icon-x"></use></svg>
      </button>
    </div>
  {/each}
</div>
