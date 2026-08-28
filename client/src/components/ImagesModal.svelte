<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { imagesModalOpen } from "../stores/imagesModal";
  import { docsStore, activeIdStore, deleteDocImage, getActiveDoc } from "../stores/docs";
  import { confirmAction } from "../stores/confirmDialog";

  // Reads $docsStore/$activeIdStore directly (not getActiveDoc() for the
  // primary lookup, which unwraps both via the non-reactive get() —
  // invisible to $derived's dependency tracking, so the list would never
  // refresh after a delete without a manual re-render call, the same trap
  // app.ts's old renderImagesList() sidestepped by just re-running itself
  // imperatively after every mutation). $docsStore/$activeIdStore are
  // still referenced directly above, so this $derived still re-runs
  // whenever either changes — the fallback below just needs to resolve
  // to the *active* document, not an arbitrary one, so it reuses
  // getActiveDoc()'s own workspace-scoped fallback instead of the old
  // `|| $docsStore[0]` (which could hand back a document from a
  // different workspace than the one actually open).
  const images = $derived.by(() => {
    if (!$imagesModalOpen) return [];
    const doc = $docsStore.find((d) => d.id === $activeIdStore) || getActiveDoc();
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

  function insertExisting(key: string) {
    const view = window.MDE.getEditor();
    const alt = key.replace(/\.[^.]+$/, "") || "image";
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: `![${alt}](${key})` } });
    view.focus();
    close();
  }

  let uploadInputEl: HTMLInputElement | undefined = $state();

  function onUploadChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!file) return;
    close();
    window.MDE.insertImageWithUpload?.(file);
  }

  async function removeImage(key: string) {
    if (!(await confirmAction(`Delete "${key}"?`, "Any reference to it in the text will show as a broken image."))) return;
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
    <div class="images-modal-upload-row">
      <button type="button" class="secondary-btn" onclick={() => uploadInputEl?.click()}>
        <svg class="icon"><use href="#icon-upload"></use></svg> Upload new image
      </button>
      <input id="imagesUploadInput" type="file" accept="image/*" hidden bind:this={uploadInputEl} onchange={onUploadChange} />
    </div>
    {#if images.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-images"></use></svg>
        <div class="empty-state-title">No images yet</div>
        <div class="empty-state-desc">Paste, drop, or use the toolbar button to add one.</div>
      </div>
    {:else}
      <div class="images-list">
        {#each images as img (img.key)}
          <div class="image-item" class:unused={!img.used}>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <img
              src={img.dataUrl}
              alt=""
              role="button"
              tabindex="0"
              class="image-item-thumb"
              title="Click to insert"
              onclick={() => insertExisting(img.key)}
            />
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
