// Escape must dismiss every modal. app.ts's global Escape handler
// deliberately skips [data-svelte-modal] backdrops, so each Svelte modal
// has to handle the key itself — these are the eight that didn't.
import "fake-indexeddb/auto";
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

import ConfirmDialog from "../../../../client/src/components/ConfirmDialog.svelte";
import ShareChoiceModal from "../../../../client/src/components/ShareChoiceModal.svelte";
import GistVisibilityDialog from "../../../../client/src/components/GistVisibilityDialog.svelte";
import TurnstilePrompt from "../../../../client/src/components/TurnstilePrompt.svelte";
import DocEditModal from "../../../../client/src/components/DocEditModal.svelte";
import MoveToWorkspaceModal from "../../../../client/src/components/MoveToWorkspaceModal.svelte";
import JoinWorkspaceModal from "../../../../client/src/components/JoinWorkspaceModal.svelte";
import RepoConflictModal from "../../../../client/src/components/RepoConflictModal.svelte";

import { confirmRequest } from "../../../../client/src/stores/confirmDialog";
import { shareChoiceRequest } from "../../../../client/src/stores/shareChoice";
import { gistVisibilityRequest } from "../../../../client/src/stores/gistVisibilityDialog";
import { turnstilePromptOpen } from "../../../../client/src/stores/turnstile";
import { docEditModalOpen } from "../../../../client/src/stores/docEditModalOpen";
import { moveToWorkspaceDocId } from "../../../../client/src/stores/moveToWorkspace";
import { pendingJoin } from "../../../../client/src/stores/joinWorkspace";
import { repoConflictModalOpen, repoConflictState } from "../../../../client/src/stores/repoSync";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore } from "../../../../client/src/stores/workspaces";

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.MDE = {
    renameActiveDoc: vi.fn(),
    commitActiveDocRename: vi.fn(),
    onDocMetadataChanged: vi.fn(),
    onDocCitationsChanged: vi.fn(),
    formatRelativeTime: () => "just now",
  } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set("d1");
});

test("ConfirmDialog: Escape cancels the pending confirmation", async () => {
  const resolve = vi.fn();
  confirmRequest.set({ title: "Delete?", message: "Sure?", confirmLabel: "Delete", danger: true, resolve });
  await render(ConfirmDialog);

  pressEscape();

  await expect.poll(() => resolve.mock.calls[0]?.[0]).toBe(false);
  expect(get(confirmRequest)).toBeNull();
});

test("ShareChoiceModal: Escape resolves the pending choice as cancel", async () => {
  const resolve = vi.fn();
  shareChoiceRequest.set({ docName: "Doc", workspaceName: "WS", docCount: 2, resolve });
  await render(ShareChoiceModal);

  pressEscape();

  await expect.poll(() => resolve.mock.calls[0]?.[0]).toBe("cancel");
  expect(get(shareChoiceRequest)).toBeNull();
});

test("GistVisibilityDialog: Escape resolves the pending visibility as null", async () => {
  const resolve = vi.fn();
  gistVisibilityRequest.set({ resolve });
  await render(GistVisibilityDialog);

  pressEscape();

  await expect.poll(() => resolve.mock.calls.length).toBe(1);
  expect(resolve.mock.calls[0]?.[0]).toBeNull();
  expect(get(gistVisibilityRequest)).toBeNull();
});

test("TurnstilePrompt: Escape closes the challenge prompt", async () => {
  turnstilePromptOpen.set(true);
  await render(TurnstilePrompt);

  pressEscape();

  await expect.poll(() => get(turnstilePromptOpen)).toBe(false);
});

test("DocEditModal: Escape closes the editor", async () => {
  docEditModalOpen.set(true);
  await render(DocEditModal);

  pressEscape();

  await expect.poll(() => get(docEditModalOpen)).toBe(false);
});

test("MoveToWorkspaceModal: Escape closes the picker", async () => {
  moveToWorkspaceDocId.set("d1");
  await render(MoveToWorkspaceModal);

  pressEscape();

  await expect.poll(() => get(moveToWorkspaceDocId)).toBeNull();
});

test("JoinWorkspaceModal: Escape cancels the join choice", async () => {
  pendingJoin.set({ remoteId: "room-1", workspaceName: "Shared", docs: [], landOnDocId: "d1" });
  await render(JoinWorkspaceModal);

  pressEscape();

  await expect.poll(() => get(pendingJoin)).toBeNull();
});

test("RepoConflictModal: Escape closes the conflict dialog", async () => {
  repoConflictModalOpen.set(true);
  repoConflictState.set({ kind: "pull", conflicts: [], deletions: [], onResolve: async () => {} });
  await render(RepoConflictModal);

  pressEscape();

  await expect.poll(() => get(repoConflictModalOpen)).toBe(false);
  expect(get(repoConflictState)).toBeNull();
});
