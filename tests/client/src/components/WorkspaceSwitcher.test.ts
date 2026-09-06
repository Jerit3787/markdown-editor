import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import WorkspaceSwitcher from "../../../../client/src/components/WorkspaceSwitcher.svelte";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  window.MDE = { updatePreview: vi.fn() } as unknown as typeof window.MDE;
  workspacesStore.set([
    { id: "wa", name: "Alpha", createdAt: 1, updatedAt: 1 },
    { id: "wb", name: "Bravo", createdAt: 2, updatedAt: 2 },
  ]);
  activeWorkspaceIdStore.set("wa");
  docsStore.set([
    { id: "da", name: "Doc A", content: "", updatedAt: 0, createdAt: 0, workspaceId: "wa" },
    { id: "db", name: "Doc B", content: "", updatedAt: 0, createdAt: 0, workspaceId: "wb" },
  ]);
  activeIdStore.set("da");
});

test("DOC-09: shows the active workspace name and switches to another on click", async () => {
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Alpha").click(); // open the popover (trigger shows the active name)
  await screen.getByText("Bravo").click();
  expect(get(activeWorkspaceIdStore)).toBe("wb");
});

test("DOC-09: 'New workspace' creates one, activates it, and drops into rename mode", async () => {
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Alpha").click();
  const before = get(workspacesStore).length;
  await screen.getByRole("button", { name: "New workspace" }).click();

  const wss = get(workspacesStore);
  expect(wss.length).toBe(before + 1);
  const created = wss.find((w) => w.id !== "wa" && w.id !== "wb")!;
  expect(created).toBeDefined();
  expect(get(activeWorkspaceIdStore)).toBe(created.id);
  // startCreate opens the inline rename input on the new row.
  await expect.element(screen.getByRole("textbox")).toBeVisible();
});

test("DOC-09: renaming a workspace inline updates its name", async () => {
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Alpha").click();
  await screen.getByRole("button", { name: "Rename workspace" }).first().click();
  const input = screen.getByRole("textbox");
  await input.fill("Alpha Renamed");
  await input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  expect(get(workspacesStore).find((w) => w.id === "wa")?.name).toBe("Alpha Renamed");
});
