import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import DocInfoPanel from "../../../../client/src/components/DocInfoPanel.svelte";
import { docInfoPanelOpen } from "../../../../client/src/stores/docInfoPanel";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  // DocInfoPanel's template calls window.MDE.formatRelativeTime(...)
  // directly (not optional-chained) for the Created/Edited rows, so it
  // must be stubbed or rendering throws — the rest of window.MDE isn't
  // touched by anything these tests exercise.
  window.MDE = { formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
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
