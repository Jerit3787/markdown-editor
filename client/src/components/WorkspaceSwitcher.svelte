<script lang="ts">
  import { onMount } from "svelte";
  import {
    workspacesStore,
    activeWorkspaceIdStore,
    createWorkspace,
    renameWorkspace,
    switchWorkspace,
    deleteWorkspaceRecord,
    promoteEphemeralWorkspace,
  } from "../stores/workspaces";
  import { docsStore, removeDocById, ensureActiveDocInWorkspace, persistDocs } from "../stores/docs";
  import { confirmAction } from "../stores/confirmDialog";
  import { showToast } from "../stores/toast";
  import { pushWorkspaceRename, teardownWorkspace } from "../collab";

  let open = $state(false);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");
  let renameInputEl: HTMLInputElement | undefined = $state();

  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const docCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const d of $docsStore) counts.set(d.workspaceId, (counts.get(d.workspaceId) || 0) + 1);
    return counts;
  });

  function toggle() {
    open = !open;
  }
  function close() {
    open = false;
    renamingId = null;
  }

  function pick(id: string) {
    if (switchWorkspace(id)) ensureActiveDocInWorkspace(id);
    close();
  }

  function keepWorkspace(id: string) {
    promoteEphemeralWorkspace(id);
    persistDocs();
    close();
  }

  function startCreate() {
    const ws = createWorkspace("New workspace");
    ensureActiveDocInWorkspace(ws.id); // brand new, always empty
    renamingId = ws.id;
    renameValue = ws.name;
  }

  function startRename(id: string, name: string, e: MouseEvent) {
    e.stopPropagation();
    renamingId = id;
    renameValue = name;
  }

  function commitRename() {
    if (renamingId) {
      renameWorkspace(renamingId, renameValue.trim());
      pushWorkspaceRename(renamingId, renameValue.trim());
    }
    renamingId = null;
  }

  async function remove(id: string, name: string, e: MouseEvent) {
    e.stopPropagation();
    const ws = $workspacesStore.find((w) => w.id === id);
    if (!ws) return;
    const count = docCounts.get(id) || 0;
    const docsPhrase = count > 0 ? `${count} document${count === 1 ? "" : "s"}` : "no documents";

    // Owner-vs-merger for a shared workspace that isn't a pure mirror (both
    // have shared && !mirrored) — resolved by a fresh access fetch. The
    // server's DELETE is the real gate (403s a non-owner harmlessly), so a
    // failed fetch just falls back to the owner phrasing.
    let iAmOwner = false;
    if (ws.shared && !ws.mirrored && ws.remoteId) {
      try {
        const res = await fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/access`);
        iAmOwner = res.ok ? (await res.json()).owner === window.MDE.githubUsername && !!window.MDE.githubUsername : true;
      } catch {
        iAmOwner = true;
      }
    }

    let title = `Delete "${name}"?`;
    let message: string;
    if (ws.mirrored) {
      title = `Remove "${name}"?`;
      message = "This removes your local copy. You can open it again from the share link unless the owner has revoked access.";
    } else if (ws.shared && iAmOwner) {
      message = `This is a shared workspace. Deleting it revokes access for everyone you've shared it with and removes its ${docsPhrase} for them too. This can't be undone.`;
    } else if (ws.shared) {
      title = `Remove "${name}"?`;
      message = `This removes your workspace and its ${docsPhrase} from this device. The shared workspace itself stays available to its owner and other collaborators.`;
    } else {
      message = count > 0 ? `This also deletes its ${docsPhrase}. This can't be undone.` : "This can't be undone.";
    }

    if (!(await confirmAction(title, message))) return;

    if (ws.shared && iAmOwner && ws.remoteId) {
      try {
        const res = await fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}`, { method: "DELETE" });
        if (res.status === 403) {
          showToast("Removed from this device. You weren't the owner, so the shared workspace still exists for others.", "info");
        } else if (!res.ok && res.status !== 410) {
          showToast("Couldn't reach the server to revoke sharing — removed locally; collaborators may keep access until the room is cleaned up.", "error");
        }
      } catch {
        showToast("Couldn't reach the server to revoke sharing — removed locally.", "error");
      }
      teardownWorkspace();
    } else if (ws.shared) {
      teardownWorkspace();
    }

    const docIds = $docsStore.filter((d) => d.workspaceId === id).map((d) => d.id);
    docIds.forEach(removeDocById);
    deleteWorkspaceRecord(id);
    if ($activeWorkspaceIdStore) ensureActiveDocInWorkspace($activeWorkspaceIdStore);
    close();
  }

  $effect(() => {
    if (renamingId) renameInputEl?.focus();
  });

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (open && !(e.target as HTMLElement).closest(".workspace-switcher")) close();
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });
</script>

<div class="workspace-switcher">
  <button type="button" class="workspace-switcher-trigger" onclick={toggle}>
    <span class="workspace-name">{activeWorkspace?.name ?? "No workspace"}</span>
    {#if activeWorkspace?.ephemeral}<span class="workspace-preview-badge">Preview</span>{/if}
    <svg class="icon"><use href="#icon-chevron-down"></use></svg>
  </button>
  {#if open}
    <div class="workspace-switcher-popover">
      {#if activeWorkspace?.ephemeral}
        <button type="button" class="workspace-keep-btn" onclick={() => keepWorkspace(activeWorkspace!.id)}>Keep this workspace</button>
      {/if}
      <ul class="workspace-list">
        {#each $workspacesStore as ws (ws.id)}
          <li class:active={ws.id === $activeWorkspaceIdStore}>
            {#if renamingId === ws.id}
              <input
                bind:this={renameInputEl}
                class="workspace-rename-input"
                bind:value={renameValue}
                onblur={commitRename}
                onkeydown={(e) => e.key === "Enter" && commitRename()}
                onclick={(e) => e.stopPropagation()}
              />
            {:else}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="workspace-row" onclick={() => pick(ws.id)}>
                <span class="workspace-row-name">{ws.name}</span>
                <button type="button" class="icon-btn" aria-label="Rename workspace" onclick={(e) => startRename(ws.id, ws.name, e)}>
                  <svg class="icon"><use href="#icon-pencil"></use></svg>
                </button>
                <button type="button" class="icon-btn" aria-label="Delete workspace" onclick={(e) => remove(ws.id, ws.name, e)}>
                  <svg class="icon"><use href="#icon-trash-2"></use></svg>
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <button type="button" class="workspace-new-btn" onclick={startCreate}>
        <svg class="icon"><use href="#icon-plus"></use></svg> New workspace
      </button>
    </div>
  {/if}
</div>
