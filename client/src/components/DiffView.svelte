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
      <div class="diff-view-gutter">{row.leftLine ?? ""}</div>
      <div class="diff-view-cell" class:diff-removed={row.type === "changed" || row.type === "removed"}>
        {#if row.leftSegments}
          {#each row.leftSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
        {:else}
          {row.leftText ?? ""}
        {/if}
      </div>
      <div class="diff-view-gutter">{row.rightLine ?? ""}</div>
      <div class="diff-view-cell" class:diff-added={row.type === "changed" || row.type === "added"}>
        {#if row.rightSegments}
          {#each row.rightSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
        {:else}
          {row.rightText ?? ""}
        {/if}
      </div>
    </div>
  {/each}
</div>
