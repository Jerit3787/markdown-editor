<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { openGistModalOpen } from "../stores/openGistModal";
  import { githubUsername } from "../stores/github";
  import { createDoc } from "../stores/docs";
  import { showToast } from "../stores/toast";
  import { parseGistId, fetchRaw, errorMessage, extractInlineImages, formatGistDate } from "../gist";

  const INPUT_KEY = "__input__"; // shares the busy/failed indicator mechanism below with the URL/ID field's own "Open" button, matching the original's one-function-any-button design

  let inputValue = $state("");
  let busyKey = $state<string | null>(null); // gist id, or INPUT_KEY, currently being opened — or null
  let failedKey = $state<string | null>(null);
  let gists = $state<any[]>([]);
  let listHint = $state("Sign in with GitHub to see your own gists here.");

  function close() {
    openGistModalOpen.set(false);
  }

  async function loadGistList() {
    if (!$githubUsername) {
      listHint = "Sign in with GitHub to see your own gists here.";
      gists = [];
      return;
    }
    listHint = "Loading your gists…";
    try {
      const res = await fetch("/api/gists");
      if (!res.ok) throw new Error(await errorMessage(res));
      const all: any[] = await res.json();
      const withMd = all.filter((g) => Object.keys(g.files || {}).some((name: string) => /\.(md|markdown)$/i.test(name)));
      gists = withMd;
      listHint = withMd.length === 0 ? "No markdown gists found." : "";
    } catch {
      listHint = "Couldn't load your gists.";
      gists = [];
    }
  }

  // key is the gist's own id for a list row, or INPUT_KEY for the URL/ID
  // field's "Open" button — whichever triggered this gets its own
  // Opening…/Failed indicator, matching the original's shared-function-
  // any-button design.
  async function openGistById(id: string, key: string) {
    busyKey = key;
    failedKey = null;
    try {
      const res = await fetch(`/api/gist/${id}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      const files: any[] = Object.values(data.files || {});
      const file = files.find((f) => /\.(md|markdown)$/i.test(f.filename)) || files[0];
      if (!file) throw new Error("Gist has no files");
      const rawContent = file.truncated ? await fetchRaw(file.raw_url) : file.content;
      const name = file.filename.replace(/\.(md|markdown)$/i, "");
      const { content, images } = extractInlineImages(rawContent);
      createDoc({ name, content, images: Object.keys(images).length ? images : undefined, gistId: data.id, gistFilename: file.filename });
      close();
      showToast(`Opened "${name}" from Gist`, "success");
    } catch {
      failedKey = key;
      setTimeout(() => (failedKey = null), 2000);
      showToast("Couldn't open that Gist", "error");
    } finally {
      busyKey = null;
    }
  }

  function openFromInput() {
    const id = parseGistId(inputValue.trim());
    if (id) openGistById(id, INPUT_KEY);
  }

  function gistDisplayName(gist: any): string {
    const filenames = Object.keys(gist.files || {});
    const mdName = filenames.find((name) => /\.(md|markdown)$/i.test(name)) || filenames[0];
    return gist.description || mdName || "Untitled gist";
  }

  $effect(() => {
    if ($openGistModalOpen) {
      inputValue = "";
      void loadGistList();
    }
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $openGistModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || !e.data || e.data.type !== "mde-github-auth") return;
      if (e.data.ok) {
        window.MDE.onGithubAuthComplete && window.MDE.onGithubAuthComplete();
        void loadGistList();
      } else {
        alert(`GitHub sign-in failed: ${e.data.message || "unknown error"}`);
      }
    };
    window.addEventListener("message", onMessage);

    return () => {
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("message", onMessage);
    };
  });
</script>

{#if $openGistModalOpen}
  <Modal title="Open from GitHub Gist" icon="icon-github" wide labelledBy="openGistModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Works with any public Gist, or your own private ones once you're signed in — paste its URL/ID, or pick it from the list below.</Toggletip>
    {/snippet}

    <label class="modal-field">
      <span>Gist URL or ID</span>
      <div class="share-row">
        <input type="text" placeholder="https://gist.github.com/... or ID" aria-label="Gist URL or ID" bind:value={inputValue} onkeydown={(e) => e.key === "Enter" && openFromInput()} />
        <button class="secondary-btn" type="button" disabled={busyKey === INPUT_KEY} onclick={openFromInput}>
          {busyKey === INPUT_KEY ? "Opening…" : failedKey === INPUT_KEY ? "Failed" : "Open"}
        </button>
      </div>
    </label>

    <div class="menu-divider"></div>
    <div class="menu-section-label">Your Gists</div>
    {#if listHint}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-github"></use></svg>
        <div class="empty-state-title">{!$githubUsername ? "Sign in required" : "No gists"}</div>
        <div class="empty-state-desc">{listHint}</div>
        {#if !$githubUsername}
          <button type="button" class="primary-btn" onclick={() => window.MDE.openGithubSignInPopup()} style="margin-top: 8px;">
            <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
          </button>
        {/if}
      </div>
    {/if}
    <div class="images-list">
      {#each gists as gist (gist.id)}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{gistDisplayName(gist)}</div>
            <div class="gist-date">Updated {formatGistDate(gist.updated_at)}</div>
          </div>
          <button class="secondary-btn" type="button" disabled={busyKey === gist.id} onclick={() => openGistById(gist.id, gist.id)}>
            {busyKey === gist.id ? "Opening…" : failedKey === gist.id ? "Failed" : "Open"}
          </button>
        </div>
      {/each}
    </div>
  </Modal>
{/if}
