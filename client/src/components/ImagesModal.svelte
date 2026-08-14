<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { imagesModalOpen } from "../stores/imagesModal";
  import { docsStore, activeIdStore, deleteDocImage } from "../stores/docs";
  import { confirmAction } from "../stores/confirmDialog";

  // Reads $docsStore/$activeIdStore directly (not getActiveDoc(), which
  // unwraps both via the non-reactive get() — invisible to $derived's
  // dependency tracking, so the list would never refresh after a
  // delete without a manual re-render call, the same trap
  // app.ts's old renderImagesList() sidestepped by just re-running
  // itself imperatively after every mutation).
  const images = $derived.by(() => {
    if (!$imagesModalOpen) return [];
    const doc = $docsStore.find((d) => d.id === $activeIdStore) || $docsStore[0];
    const imgs = (doc && doc.images) || {};
    const rawContent = window.MDE.getEditor().state.doc.toString();
    return Object.entries(imgs).map(([key, dataUrl]) => ({
      key,
      dataUrl,
      used: rawContent.includes(`](${key})`),
    }));
  });

  function close() {
    imagesModalOpen.set(false);
  }

  function formatBytes(base64Length: number) {
    const bytes = Math.round(base64Length * 0.75);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function removeImage(key: string) {
    if (!(await confirmAction(`Delete "${key}"? Any reference to it in the text will show as a broken image.`))) return;
    deleteDocImage(key);
    window.MDE.updatePreview();
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $imagesModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $imagesModalOpen}
  <Modal title="Images in this document" icon="icon-images" wide labelledBy="imagesModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Images are stored inside this document, not uploaded anywhere, unless you publish it to a Gist.</Toggletip>
    {/snippet}
    {#if images.length === 0}
      <p class="modal-hint">No images in this document yet. Paste, drop, or use the toolbar 🖼 button to add one.</p>
    {:else}
      <div class="images-list">
        {#each images as img (img.key)}
          <div class="image-item" class:unused={!img.used}>
            <img src={img.dataUrl} alt="" />
            <div class="image-meta">
              <div class="image-name">{img.key}{#if !img.used} <span class="image-unused-label">(not used in this document)</span>{/if}</div>
              <div class="image-size">{formatBytes(img.dataUrl.length)}</div>
            </div>
            <button class="icon-btn" title="Delete image" aria-label={`Delete ${img.key}`} onclick={() => removeImage(img.key)}>
              <svg class="icon"><use href="#icon-trash-2"></use></svg>
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </Modal>
{/if}
