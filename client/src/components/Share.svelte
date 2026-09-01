<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { githubUsername } from "../stores/github";
  import { shareModalOpen, shareAccess, shareTargetName } from "../stores/share";
  import {
    closeShareModal,
    setAccessMode,
    setRole,
    setInviteRole,
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
    // +32px reserves room for the native dropdown arrow, which the mirror
    // itself doesn't render (appearance:auto draws it inside the select's
    // own box, not as separate content the text-only mirror would count).
    // Mobile Safari's own arrow affordance claims noticeably more of that
    // space than desktop Chromium's — 22px was tuned against the latter
    // and clipped the label text on an iPhone (reported live); .share-
    // access-select's own text-overflow:ellipsis is a second line of
    // defense in case some other engine still needs more than 32px.
    accessSelectEl.style.width = `${accessMirrorEl.offsetWidth + 32}px`;
  });
  const linkDisabled = $derived(!isAnyone && access.invited.length === 0);
  const hint = $derived(
    accessMode === "anyone-link"
      ? `Anyone with this link can ${ROLE_VERBS[access.role] || "edit"}, no account needed`
      : accessMode === "anyone-account"
        ? `Anyone with a GitHub account and this link can ${ROLE_VERBS[access.role] || "edit"}`
        : "Only people with access can open with the link"
  );

  function onInviteRoleChange(username: string, e: Event) {
    setInviteRole(username, (e.target as HTMLSelectElement).value);
  }

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
  <Modal title={`Share "${$shareTargetName}"`} labelledBy="shareModalTitle" onClose={closeShareModal}>
    {#snippet quickAction()}
      <Toggletip>Invite specific people by GitHub username, or turn on general access to share one link with anyone. Viewer can only look, Reviewer can also comment, Editor can change the document.</Toggletip>
    {/snippet}

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
      {#each access.invited as person (person.username)}
        <div class="share-person">
          <span class="presence-avatar" style:background="var(--text-dim)">{initial(person.username)}</span>
          <span class="share-person-name">{person.username}</span>
          <select
            class="share-role-select"
            aria-label={`Access level for ${person.username}`}
            value={person.role}
            onchange={(e) => onInviteRoleChange(person.username, e)}
          >
            <option value="viewer">Viewer</option>
            <option value="reviewer">Reviewer</option>
            <option value="editor">Editor</option>
          </select>
          <button type="button" class="share-person-remove" aria-label={`Remove ${person.username}`} onclick={() => removeInvite(person.username)}>
            <svg class="icon"><use href="#icon-x"></use></svg>
          </button>
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

    {#snippet footer()}
      <button class="secondary-btn" type="button" disabled={linkDisabled} onclick={copyLink}>
        <svg class="icon"><use href="#icon-link"></use></svg> <span>{copied ? "Copied!" : "Copy link"}</span>
      </button>
      <span class="spacer"></span>
      <button class="primary-btn" type="button" onclick={closeShareModal}>Done</button>
    {/snippet}
  </Modal>
{/if}
