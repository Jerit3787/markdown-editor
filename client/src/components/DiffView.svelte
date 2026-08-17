<script lang="ts">
  import { computeDiffRows } from "../diff-lines";

  interface Props {
    before: string;
    after: string;
  }
  const { before, after }: Props = $props();

  const rows = $derived(computeDiffRows(before, after));
</script>

<div class="diff-view">
  {#each rows as row, i (i)}
    <div class="diff-view-row">
      <div class="diff-view-cell" class:diff-removed={row.type === "changed" || row.type === "removed"}>{row.leftText ?? ""}</div>
      <div class="diff-view-cell" class:diff-added={row.type === "changed" || row.type === "added"}>{row.rightText ?? ""}</div>
    </div>
  {/each}
</div>
