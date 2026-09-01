import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { get } from "svelte/store";
import JoinWorkspaceModal from "../../../../client/src/components/JoinWorkspaceModal.svelte";
import { pendingJoin } from "../../../../client/src/stores/joinWorkspace";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { docsStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  localStorage.clear();
  pendingJoin.set(null);
  workspacesStore.set([{ id: "ws-1", name: "My Workspace", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([]);
});

function openPendingJoin() {
  pendingJoin.set({
    remoteId: "room-x",
    workspaceName: "Shared workspace",
    docs: [
      { id: "d1", name: "Doc A", content: "", updatedAt: 0, createdAt: 0 },
      { id: "d2", name: "Doc B", content: "", updatedAt: 0, createdAt: 0 },
    ],
    landOnDocId: "d1",
  });
}

test("renders all three join options", async () => {
  const screen = await render(JoinWorkspaceModal);
  openPendingJoin();
  await expect.element(screen.getByRole("button", { name: "Add as new workspace" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Merge in" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Preview only" })).toBeVisible();
});

test("Preview only creates an ephemeral workspace, closes the modal, and never persists it", async () => {
  const screen = await render(JoinWorkspaceModal);
  openPendingJoin();
  await screen.getByRole("button", { name: "Preview only" }).click();
  await expect.element(screen.getByText("Join shared workspace")).not.toBeInTheDocument();
  const preview = get(workspacesStore).find((w) => w.remoteId === "room-x");
  expect(preview?.ephemeral).toBe(true);
  const persisted = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  expect(persisted.map((w: { id: string }) => w.id)).not.toContain(preview!.id);
});
