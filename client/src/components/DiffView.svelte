<script lang="ts">
  import { computeDiffRows, toUnifiedLines } from "../diff-lines";
  import { parseImageOnlyLine } from "../diff-image-row";

  interface Props {
    before: string;
    after: string;
    beforeImages?: Record<string, string>;
    afterImages?: Record<string, string>;
  }
  const { before, after, beforeImages, afterImages }: Props = $props();

  const rows = $derived(computeDiffRows(before, after));
  const unifiedLines = $derived(toUnifiedLines(rows));

  let mode = $state<"split" | "unified">("split");

  // images: undefined map = still loading (only ever true for repo-commit
  // diffs, a later phase) -> show a spinner. Map present but the specific
  // ref missing -> render <img src={ref}> anyway, which isn't a valid URL
  // so the browser shows its own broken-image icon (same fallback
  // convention version-preview.ts already uses).
  function resolvedSrc(ref: string, images: Record<string, string> | undefined): string | undefined {
    if (!images) return undefined;
    return images[ref] ?? ref;
  }
</script>

<div class="diff-view-mode-toggle">
  <button type="button" class:active={mode === "split"} onclick={() => (mode = "split")}>Split</button>
  <button type="button" class:active={mode === "unified"} onclick={() => (mode = "unified")}>Unified</button>
</div>

{#if mode === "split"}
  <div class="diff-view">
    {#each rows as row, i (i)}
      {@const leftImage = row.type !== "same" ? parseImageOnlyLine(row.leftText) : null}
      {@const rightImage = row.type !== "same" ? parseImageOnlyLine(row.rightText) : null}
      <div class="diff-view-row">
        <div class="diff-view-gutter">{row.leftLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-removed={row.type === "changed" || row.type === "removed"}>
          {#if leftImage}
            {#if beforeImages}
              <img class="diff-image-thumb" src={resolvedSrc(leftImage.ref, beforeImages)} alt={leftImage.alt} />
            {:else}
              <div class="diff-image-loading"></div>
            {/if}
          {:else if row.leftSegments}
            {#each row.leftSegments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {row.leftText ?? ""}
          {/if}
        </div>
        <div class="diff-view-gutter">{row.rightLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-added={row.type === "changed" || row.type === "added"}>
          {#if rightImage}
            {#if afterImages}
              <img class="diff-image-thumb" src={resolvedSrc(rightImage.ref, afterImages)} alt={rightImage.alt} />
            {:else}
              <div class="diff-image-loading"></div>
            {/if}
          {:else if row.rightSegments}
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
      {@const lineImage = line.type !== "same" ? parseImageOnlyLine(line.text) : null}
      {@const images = line.type === "removed" ? beforeImages : line.type === "added" ? afterImages : undefined}
      <div class="diff-view-row">
        <div class="diff-view-gutter">{line.leftLine ?? ""}</div>
        <div class="diff-view-gutter">{line.rightLine ?? ""}</div>
        <div class="diff-view-cell" class:diff-removed={line.type === "removed"} class:diff-added={line.type === "added"}>
          {#if lineImage}
            {#if images}
              <img class="diff-image-thumb" src={resolvedSrc(lineImage.ref, images)} alt={lineImage.alt} />
            {:else}
              <div class="diff-image-loading"></div>
            {/if}
          {:else if line.segments}
            {#each line.segments as seg, j (j)}<span class:diff-segment-changed={seg.changed}>{seg.text}</span>{/each}
          {:else}
            {line.text}
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
