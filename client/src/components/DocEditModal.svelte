<script lang="ts">
  import Modal from "./Modal.svelte";
  import { docEditModalOpen } from "../stores/docEditModalOpen";
  import { activeIdStore, getActiveDoc, docsStore, setActiveDocMetadata, setActiveDocCitations } from "../stores/docs";
  import type { MetadataPair } from "../mmd-metadata";
  import { DEFAULT_CITATION_PREFS, type CitationPrefs, type BibEntry } from "../mmd-citations";

  // Same $docsStore.find(...) pattern DocInfoPanel.svelte uses, and for the
  // same reason: recompute when the active doc's own fields change in
  // place, not only when $activeIdStore switches to a different document.
  const doc = $derived($activeIdStore ? $docsStore.find((d) => d.id === $activeIdStore) || getActiveDoc() : undefined);

  let nameBeforeEdit = "";

  function onNameFocus(e: FocusEvent) {
    nameBeforeEdit = doc?.name ?? "";
    const input = e.target as HTMLInputElement;
    if (input.value === "Untitled") input.value = "";
  }
  function onNameInput(e: Event) {
    window.MDE.renameActiveDoc((e.target as HTMLInputElement).value || "Untitled");
  }
  function onNameBlur() {
    window.MDE.commitActiveDocRename(nameBeforeEdit);
  }
  function onNameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  }

  function close() {
    docEditModalOpen.set(false);
  }

  function updateMetadata(next: MetadataPair[]) {
    if (!doc) return;
    setActiveDocMetadata(next);
    window.MDE.onDocMetadataChanged?.(doc.id, next);
  }

  function addMetadataField() {
    updateMetadata([...(doc?.metadata ?? []), { key: "", value: "" }]);
  }

  function updateMetadataField(index: number, field: "key" | "value", value: string) {
    const next = (doc?.metadata ?? []).map((pair, i) => (i === index ? { ...pair, [field]: value } : pair));
    updateMetadata(next);
  }

  function removeMetadataField(index: number) {
    updateMetadata((doc?.metadata ?? []).filter((_, i) => i !== index));
  }

  const citationPrefs = $derived(doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS);
  const bibliography = $derived(doc?.citations?.bibliography ?? []);

  function updateCitations(prefs: CitationPrefs, bib: BibEntry[]) {
    if (!doc) return;
    const citations = { prefs, bibliography: bib };
    setActiveDocCitations(citations);
    window.MDE.onDocCitationsChanged?.(doc.id, citations);
    window.MDE.updatePreview?.();
  }

  function setMarkerStyle(markerStyle: CitationPrefs["markerStyle"]) {
    updateCitations({ ...citationPrefs, markerStyle }, bibliography);
  }

  function setBibliographySource(bibliographySource: CitationPrefs["bibliographySource"]) {
    // Falls back to "numbered" when leaving structured mode while
    // author-year was active — author-year has nothing reliable to render
    // once there's no structured author/year data behind it.
    const displayStyle = bibliographySource === "text" && citationPrefs.displayStyle === "author-year" ? "numbered" : citationPrefs.displayStyle;
    updateCitations({ ...citationPrefs, bibliographySource, displayStyle }, bibliography);
  }

  function setDisplayStyle(displayStyle: CitationPrefs["displayStyle"]) {
    updateCitations({ ...citationPrefs, displayStyle }, bibliography);
  }

  function addBibEntry() {
    updateCitations(citationPrefs, [...bibliography, { key: "", author: "", year: "", text: "" }]);
  }

  function updateBibEntry(index: number, field: keyof BibEntry, value: string) {
    updateCitations(
      citationPrefs,
      bibliography.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
    );
  }

  function removeBibEntry(index: number) {
    updateCitations(
      citationPrefs,
      bibliography.filter((_, i) => i !== index),
    );
  }
</script>

{#if $docEditModalOpen && doc}
  <Modal title="Edit document" icon="icon-pencil" elevated labelledBy="docEditTitle" onClose={close}>
    <div class="doc-info-row">
      <label class="doc-info-primary" for="docEditNameInput">Name</label>
      <input
        id="docEditNameInput"
        type="text"
        class="doc-edit-name-input"
        value={doc.name}
        onfocus={onNameFocus}
        oninput={onNameInput}
        onblur={onNameBlur}
        onkeydown={onNameKeydown}
      />
    </div>
    <div class="menu-section-label">Metadata</div>
    <div class="doc-info-metadata-list">
      {#each doc.metadata ?? [] as pair, i}
        <div class="doc-info-metadata-row">
          <input type="text" placeholder="Key" value={pair.key} oninput={(e) => updateMetadataField(i, "key", (e.target as HTMLInputElement).value)} />
          <input type="text" placeholder="Value" value={pair.value} oninput={(e) => updateMetadataField(i, "value", (e.target as HTMLInputElement).value)} />
          <button type="button" class="doc-info-metadata-remove" aria-label="Remove field" onclick={() => removeMetadataField(i)}>
            <svg class="icon"><use href="#icon-trash-2"></use></svg>
          </button>
        </div>
      {/each}
      <button type="button" class="secondary-btn" onclick={addMetadataField}>Add field</button>
    </div>
    <div class="menu-section-label">Citations</div>
    <div class="doc-info-citation-prefs">
      <div class="tab-switch" role="tablist">
        <button type="button" class="tab-switch-btn" class:active={citationPrefs.markerStyle === "pandoc"} onclick={() => setMarkerStyle("pandoc")}>Pandoc [@key]</button>
        <button type="button" class="tab-switch-btn" class:active={citationPrefs.markerStyle === "multimarkdown"} onclick={() => setMarkerStyle("multimarkdown")}>MultiMarkdown [#key]</button>
      </div>
      <div class="tab-switch" role="tablist">
        <button type="button" class="tab-switch-btn" class:active={citationPrefs.bibliographySource === "text"} onclick={() => setBibliographySource("text")}>Plain text</button>
        <button type="button" class="tab-switch-btn" class:active={citationPrefs.bibliographySource === "structured"} onclick={() => setBibliographySource("structured")}>Structured</button>
      </div>
      <div class="tab-switch" role="tablist">
        <button type="button" class="tab-switch-btn" class:active={citationPrefs.displayStyle === "numbered"} onclick={() => setDisplayStyle("numbered")}>Numbered</button>
        <button
          type="button"
          class="tab-switch-btn"
          class:active={citationPrefs.displayStyle === "author-year"}
          disabled={citationPrefs.bibliographySource === "text"}
          onclick={() => setDisplayStyle("author-year")}
        >
          Author-year
        </button>
      </div>
    </div>
    {#if citationPrefs.bibliographySource === "structured"}
      <div class="doc-info-metadata-list">
        {#each bibliography as entry, i}
          <div class="doc-info-citation-row">
            <input type="text" placeholder="Key" value={entry.key} oninput={(e) => updateBibEntry(i, "key", (e.target as HTMLInputElement).value)} />
            <input type="text" placeholder="Author" value={entry.author} oninput={(e) => updateBibEntry(i, "author", (e.target as HTMLInputElement).value)} />
            <input type="text" placeholder="Year" value={entry.year} oninput={(e) => updateBibEntry(i, "year", (e.target as HTMLInputElement).value)} />
            <input type="text" placeholder="Text" value={entry.text} oninput={(e) => updateBibEntry(i, "text", (e.target as HTMLInputElement).value)} />
            <button type="button" class="doc-info-metadata-remove" aria-label="Remove entry" onclick={() => removeBibEntry(i)}>
              <svg class="icon"><use href="#icon-trash-2"></use></svg>
            </button>
          </div>
        {/each}
        <button type="button" class="secondary-btn" onclick={addBibEntry}>Add entry</button>
      </div>
    {/if}
  </Modal>
{/if}
