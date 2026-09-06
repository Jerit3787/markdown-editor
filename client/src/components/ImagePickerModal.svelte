<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { imagesModalOpen } from "../stores/imagesModal";
  import { docsStore, activeIdStore, getActiveDoc } from "../stores/docs";

  // Same reactive-lookup reasoning as ManageImagesModal's `images` derived:
  // read $docsStore/$activeIdStore directly so the grid refreshes when the
  // active doc's image map changes, with getActiveDoc()'s workspace-scoped
  // fallback for the rare "id not in the list yet" tick.
  const images = $derived.by(() => {
    if (!$imagesModalOpen) return [];
    const doc = $docsStore.find((d) => d.id === $activeIdStore) || getActiveDoc();
    const imgs = (doc && doc.images) || {};
    return Object.entries(imgs).map(([key, dataUrl]) => ({ key, dataUrl }));
  });
  const count = $derived(images.length);

  let activeTab = $state<"upload" | "existing">("upload");
  let dragging = $state(false);
  let error = $state<string | null>(null);
  let uploadInputEl: HTMLInputElement | undefined = $state();

  // Reset transient UI on every open; default to Existing only when the
  // doc already has images (matches the app's "reset on open" precedents).
  $effect(() => {
    if ($imagesModalOpen) {
      activeTab = count > 0 ? "existing" : "upload";
      error = null;
      dragging = false;
    }
  });

  function close() {
    imagesModalOpen.set(false);
  }

  function altFromKey(key: string) {
    return key.replace(/\.[^.]+$/, "") || "image";
  }

  function insertExisting(key: string) {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: `![${altFromKey(key)}](${key})` } });
    view.focus();
    close();
  }

  function handleFiles(files: FileList | null | undefined) {
    error = null;
    const list = Array.from(files || []);
    const imageFiles = list.filter((f) => f.type.startsWith("image/"));
    const rejected = list.filter((f) => !f.type.startsWith("image/"));
    if (rejected.length) error = `${rejected[0].name} isn't an image`;
    if (imageFiles.length === 0) return;
    let hadError = false;
    for (const file of imageFiles) {
      window.MDE.insertImageWithUpload?.(file, undefined, (msg) => {
        error = msg;
        hadError = true;
      });
    }
    if (!hadError) close();
  }

  function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    handleFiles(input.files);
    input.value = "";
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
  <Modal title="Insert image" icon="icon-image" wide labelledBy="imagePickerModalTitle" onClose={close}>
    {#snippet tabs()}
      <button type="button" role="tab" aria-selected={activeTab === "upload"} class:active={activeTab === "upload"} onclick={() => (activeTab = "upload")}>
        Upload
      </button>
      <button type="button" role="tab" aria-selected={activeTab === "existing"} class:active={activeTab === "existing"} onclick={() => (activeTab = "existing")}>
        Existing{count > 0 ? ` (${count})` : ""}
      </button>
    {/snippet}

    {#if activeTab === "upload"}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <button
        type="button"
        class="image-dropzone"
        class:dragging
        onclick={() => uploadInputEl?.click()}
        ondragover={(e) => {
          e.preventDefault();
          dragging = true;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={(e) => {
          e.preventDefault();
          dragging = false;
          handleFiles(e.dataTransfer?.files);
        }}
      >
        <svg class="icon"><use href="#icon-upload"></use></svg>
        <span>Drop images here, or click to choose</span>
      </button>
      <input type="file" accept="image/*" multiple hidden bind:this={uploadInputEl} onchange={onPick} />
      {#if error}<div class="image-upload-error" role="alert">{error}</div>{/if}
    {:else if count === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-images"></use></svg>
        <div class="empty-state-title">No images in this document yet</div>
        <div class="empty-state-desc">
          <button type="button" class="image-picker-link" onclick={() => (activeTab = "upload")}>Add one from the Upload tab</button>
        </div>
      </div>
    {:else}
      <div class="image-picker-grid">
        {#each images as img (img.key)}
          <button type="button" class="image-picker-item" title={img.key} onclick={() => insertExisting(img.key)}>
            <img src={img.dataUrl} alt={img.key} />
          </button>
        {/each}
      </div>
    {/if}
  </Modal>
{/if}
