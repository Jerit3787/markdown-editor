import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import DocInfoPanel from "../../../../client/src/components/DocInfoPanel.svelte";
import { docInfoPanelOpen } from "../../../../client/src/stores/docInfoPanel";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  // DocInfoPanel's template calls window.MDE.formatRelativeTime(...)
  // directly (not optional-chained) for the Created/Edited rows, so it
  // must be stubbed or rendering throws — the rest of window.MDE isn't
  // touched by anything these tests exercise.
  window.MDE = { formatRelativeTime: () => "just now", updatePreview: vi.fn() } as unknown as typeof window.MDE;
  docsStore.set([{ id: "d1", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", metadata: [{ key: "Title", value: "Existing" }] }]);
  activeIdStore.set("d1");
  docInfoPanelOpen.set(true);
});

test("renders existing metadata pairs as rows", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByPlaceholder("Key").first()).toHaveValue("Title");
  await expect.element(screen.getByPlaceholder("Value").first()).toHaveValue("Existing");
});

test("Add field appends an empty row", async () => {
  const screen = await render(DocInfoPanel);
  expect((await screen.getByPlaceholder("Key").all()).length).toBe(1);

  await screen.getByRole("button", { name: "Add field" }).click();

  expect((await screen.getByPlaceholder("Key").all()).length).toBe(2);
});

test("editing a row's key updates the underlying doc metadata", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByPlaceholder("Key").first().fill("Renamed");

  const { getActiveDoc } = await import("../../../../client/src/stores/docs");
  expect(getActiveDoc()?.metadata).toEqual([{ key: "Renamed", value: "Existing" }]);
});

test("deleting a row removes it", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Remove field" }).click();
  expect((await screen.getByPlaceholder("Key").all()).length).toBe(0);

  const { getActiveDoc } = await import("../../../../client/src/stores/docs");
  expect(getActiveDoc()?.metadata).toEqual([]);
});

test("renders the citation preference controls with correct defaults", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByRole("button", { name: "Pandoc [@key]" })).toHaveClass(/active/);
  await expect.element(screen.getByRole("button", { name: "Plain text" })).toHaveClass(/active/);
  await expect.element(screen.getByRole("button", { name: "Numbered" })).toHaveClass(/active/);
});

test("Author-year is disabled when bibliography source is plain text", async () => {
  const screen = await render(DocInfoPanel);
  await expect.element(screen.getByRole("button", { name: "Author-year" })).toBeDisabled();
});

test("switching to Structured enables Author-year and shows entry rows", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Structured" }).click();
  await expect.element(screen.getByRole("button", { name: "Author-year" })).not.toBeDisabled();
  await expect.element(screen.getByPlaceholder("Key")).toBeVisible();
});

test("adding a bibliography entry updates the underlying doc", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Structured" }).click();
  await screen.getByRole("button", { name: "Add entry" }).click();
  const { getActiveDoc } = await import("../../../../client/src/stores/docs");
  expect(getActiveDoc()?.citations?.bibliography).toHaveLength(1);
});

test("a citation preference change refreshes the preview, since it changes rendered output the editor content alone would not", async () => {
  const screen = await render(DocInfoPanel);
  await screen.getByRole("button", { name: "Structured" }).click();
  expect(window.MDE.updatePreview).toHaveBeenCalled();
});
