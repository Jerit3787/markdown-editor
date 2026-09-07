import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import DocInfoPanel from "../../../../client/src/components/DocInfoPanel.svelte";
import { docInfoPanelOpen } from "../../../../client/src/stores/docInfoPanel";
import { docEditModalOpen } from "../../../../client/src/stores/docEditModalOpen";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";

beforeEach(() => {
  window.MDE = { formatRelativeTime: () => "just now", updatePreview: vi.fn() } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", metadata: [{ key: "Title", value: "Existing" }] }]);
  activeIdStore.set("d1");
  docInfoPanelOpen.set(true);
  docEditModalOpen.set(false);
});

test("shows the document name as read-only text, not an input", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("Test")).toBeVisible();
  expect((await screen.getByRole("textbox").all()).length).toBe(0);
});

test("shows metadata pairs as read-only rows, not inputs", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("Title")).toBeVisible();
  await expect.element(screen.getByText("Existing")).toBeVisible();
  expect((await screen.getByPlaceholder("Key").all()).length).toBe(0);
});

test("shows a citation preference summary line", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("Pandoc [@key] · Plain text · Numbered")).toBeVisible();
});

test("clicking Edit opens the edit modal", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Edit" }).click();
  expect(get(docEditModalOpen)).toBe(true);
});

test("shows a metadata empty state when there is no metadata", async () => {
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("No metadata", { exact: true })).toBeVisible();
});

test("MDX-03: lists documents that link to this one, and clicking a row switches to that doc", async () => {
  docsStore.set([
    { id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
    { id: "d2", name: "Linker", content: "see [[Test]] here", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
  ]);
  activeIdStore.set("d1");
  const screen = await render(DocInfoPanel);

  const row = screen.getByRole("button", { name: "Linker" });
  await expect.element(row).toBeVisible();
  await row.click();

  expect(get(activeIdStore)).toBe("d2");
  expect(get(docInfoPanelOpen)).toBe(false);
});

test("MDX-03: shows the 'No backlinks' empty state when nothing links here", async () => {
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set("d1");
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText("No backlinks", { exact: true })).toBeVisible();
});

test("A5: a non-owner collaborator sees a read-only repo-linked row", async () => {
  const { workspaceRepoLinked } = await import("../../../../client/src/stores/repoSync");
  const { collabIsOwner, leaveCollabRoom } = await import("../../../../client/src/stores/collabMode");
  leaveCollabRoom();
  workspaceRepoLinked.set(true);
  collabIsOwner.set(false);
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByText(/managed by the workspace owner/i)).toBeVisible();
  workspaceRepoLinked.set(false);
});

test("A5: the owner does not get the read-only row", async () => {
  const { workspaceRepoLinked } = await import("../../../../client/src/stores/repoSync");
  const { collabIsOwner } = await import("../../../../client/src/stores/collabMode");
  workspaceRepoLinked.set(true);
  collabIsOwner.set(true);
  const screen = await render(DocInfoPanel);
  expect((await screen.getByText(/managed by the workspace owner/i).all()).length).toBe(0);
  workspaceRepoLinked.set(false);
  collabIsOwner.set(false);
});
