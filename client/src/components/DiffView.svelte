<script lang="ts">
  import { computeDiffRows, toUnifiedLines } from "../diff-lines";

  interface Props {
    before: string;
    after: string;
  }
  const { before, after }: Props = $props();

  const rows = $derived(computeDiffRows(before, after));
  const unifiedLines = $derived(toUnifiedLines(rows));

  let mode = $state<"split" | "unified">("split");
</script>

<div class="diff-view-mode-toggle">
  <button type="button" class:active={mode === "split"} onclick={() => (mode = "split")}>Split</button>
  <button type="button" class:active={mode === "unified"} onclick={() => (mode = "unified")}>Unified</button>
</div>

{#if mode === "split"}
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
{:else}
  <div class="diff-view diff-view-unified">
    {#each unifiedLines as line, i (i)}
      <div class="diff-view-row">
        <div class="diff-view-gutter">{line.leftLine ?? ""}</div>
        <div class="diff-view-gutter">{line.rightLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-removed={line.type === "removed"} class:diff-added={line.type === "added"}>
          {#if line.segments}
            {#each line.segments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {line.text}
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
