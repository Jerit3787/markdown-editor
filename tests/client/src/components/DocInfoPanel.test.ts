import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import DocInfoPanel from "../../../../client/src/components/DocInfoPanel.svelte";
import { docInfoPanelOpen } from "../../../../client/src/stores/docInfoPanel";
import { docEditModalOpen } from "../../../../client/src/stores/docEditModalOpen";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  window.MDE = { formatRelativeTime: () => "just now", updatePreview: vi.fn() } as unknown as typeof window.MDE;
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
