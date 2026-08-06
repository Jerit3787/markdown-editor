<script lang="ts">
  import { onMount } from "svelte";
  import { githubUsername } from "../stores/github";
  import { shareModalOpen, shareAccess, shareDocName } from "../stores/share";
  import {
    closeShareModal,
    setAccessMode,
    setRole,
    buildShareLink,
    addPerson,
    removeInvite,
    colorForUsername,
    DEFAULT_ACCESS,
    type AccessMode,
  } from "../collab";
  import { showToast } from "../stores/toast";

  const ROLE_VERBS: Record<string, string> = { viewer: "view", reviewer: "comment", editor: "edit" };
  const ACCESS_MODE_LABEL: Record<AccessMode, string> = {
    restricted: "Restricted",
    "anyone-account": "Anyone with an account",
    "anyone-link": "Anyone with the link",
  };

  let addPeopleValue = $state("");
  let copied = $state(false);
  let accessSelectEl: HTMLSelectElement | undefined = $state();
  let accessMirrorEl: HTMLSpanElement | undefined = $state();

  const access = $derived($shareAccess || DEFAULT_ACCESS);
  const isAnyone = $derived(access.generalAccess === "anyone");
  const accessMode: AccessMode = $derived(
    !isAnyone ? "restricted" : access.requireAccount ? "anyone-account" : "anyone-link"
  );

  // Native <select> sizes to its widest <option> regardless of which one
  // is selected — same auto-width-via-hidden-mirror technique app.ts uses
  // for #docTitle, so the control visually matches whichever of the three
  // access-mode labels is actually showing instead of always reserving
  // room for "Anyone with an account" (the longest).
  $effect(() => {
    if (!accessMirrorEl || !accessSelectEl) return;
    accessMirrorEl.textContent = ACCESS_MODE_LABEL[accessMode];
    // +22px reserves room for the native dropdown arrow, which the mirror
    // itself doesn't render (appearance:auto draws it inside the select's
    // own box, not as separate content the text-only mirror would count).
    accessSelectEl.style.width = `${accessMirrorEl.offsetWidth + 22}px`;
  });
  const linkDisabled = $derived(!isAnyone && access.invited.length === 0);
  const hint = $derived(
    accessMode === "anyone-link"
      ? `Anyone with this link can ${ROLE_VERBS[access.role] || "edit"}, no account needed`
      : accessMode === "anyone-account"
        ? `Anyone with a GitHub account and this link can ${ROLE_VERBS[access.role] || "edit"}`
        : "Only people with access can open with the link"
  );

  interface PersonRow {
    name: string;
    color: string | null;
    roleLabel: string;
    removable: string | null;
  }

  // "People with access" means explicitly invited usernames only — NOT
  // whoever happens to be currently connected via "anyone with an
  // account"/"anyone with the link" general access, which isn't a
  // per-person grant and shouldn't read as one. Who's actually online
  // right now is the topbar presence bar's job, not this list's.
  const peopleRows = $derived.by((): PersonRow[] =>
    access.invited.map((username) => ({ name: username, color: null, roleLabel: "Invited", removable: username }))
  );

  function initial(name: string) {
    return (name || "?").trim().charAt(0).toUpperCase();
  }

  async function onAccessModeChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const mode = select.value as AccessMode;
    const ok = await setAccessMode(mode, access.role);
    if (!ok) select.value = accessMode; // revert on failure
  }

  function onRoleChange(e: Event) {
    setRole((e.target as HTMLSelectElement).value);
  }

  function onAddPeopleKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    addPerson(addPeopleValue);
    addPeopleValue = "";
  }

  function copyLink() {
    const link = buildShareLink();
    if (!link) return;
    navigator.clipboard
      .writeText(link)
      .then(() => {
        copied = true;
        setTimeout(() => (copied = false), 1200);
      })
      .catch(() => showToast("Couldn't copy the link", "error"));
  }

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) closeShareModal();
  }

  onMount(() => {
    // Same [data-svelte-modal] exclusion as Settings.svelte (see
    // app.ts's initModalEscapeKey) — this modal handles its own Escape key
    // since app.ts's generic handler can only mutate the DOM `hidden`
    // attribute directly, which wouldn't update this component's state.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $shareModalOpen) closeShareModal();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $shareModalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" data-svelte-modal onclick={backdropClick}>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
      <h2 id="shareModalTitle"><span>Share "<span>{$shareDocName}</span>"</span></h2>

      <input
        type="text"
        class="share-add-people-input"
        placeholder="Add people by GitHub username"
        aria-label="Add people by GitHub username"
        bind:value={addPeopleValue}
        onkeydown={onAddPeopleKeydown}
      />

      <div class="menu-section-label">People with access</div>
      <div class="share-people-list">
        <div class="share-person share-person-owner">
          <span class="presence-avatar" style:background={$githubUsername ? colorForUsername($githubUsername) : "var(--text-dim)"}>{initial($githubUsername || "")}</span>
          <span class="share-person-name">{$githubUsername || "Not signed in"}</span>
          <span class="share-person-role">Owner</span>
        </div>
        {#each peopleRows as row (row.removable || row.name)}
          <div class="share-person">
            <span class="presence-avatar" style:background={row.color || "var(--text-dim)"}>{initial(row.name)}</span>
            <span class="share-person-name">{row.name}</span>
            {#if row.removable}
              <button type="button" class="share-person-remove" aria-label={`Remove ${row.removable}`} onclick={() => row.removable && removeInvite(row.removable)}>
                <svg class="icon"><use href="#icon-x"></use></svg>
              </button>
            {/if}
            <span class="share-person-role">{row.roleLabel}</span>
          </div>
        {/each}
      </div>

      <div class="menu-divider"></div>
      <div class="menu-section-label">General access</div>
      <div class="share-access-row" class:active={isAnyone}>
        <span class="share-access-icon"><svg class="icon"><use href={isAnyone ? "#icon-globe" : "#icon-lock"}></use></svg></span>
        <div class="share-access-text">
          <select bind:this={accessSelectEl} class="share-access-select" aria-label="General access" value={accessMode} onchange={onAccessModeChange}>
            <option value="restricted">Restricted</option>
            <option value="anyone-account">Anyone with an account</option>
            <option value="anyone-link">Anyone with the link</option>
          </select>
          <span bind:this={accessMirrorEl} class="share-access-mirror" aria-hidden="true"></span>
          <span class="modal-hint">{hint}</span>
        </div>
        <select class="share-role-select" aria-label="Access level for people with the link" hidden={!isAnyone} value={access.role} onchange={onRoleChange}>
          <option value="viewer">Viewer</option>
          <option value="reviewer">Reviewer</option>
          <option value="editor">Editor</option>
        </select>
      </div>

      <div class="modal-actions modal-actions-share">
        <button class="secondary-btn" type="button" disabled={linkDisabled} onclick={copyLink}>
          <svg class="icon"><use href="#icon-link"></use></svg> <span>{copied ? "Copied!" : "Copy link"}</span>
        </button>
        <span class="spacer"></span>
        <button class="primary-btn" type="button" onclick={closeShareModal}>Done</button>
      </div>
    </div>
  </div>
{/if}
