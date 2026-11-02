import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import SaveToDriveDialog from "../../../../client/src/components/SaveToDriveDialog.svelte";
import { chooseDriveExport, driveExportRequest } from "../../../../client/src/stores/driveExport";

beforeEach(() => {
  driveExportRequest.set(null);
  window.MDE = {} as unknown as typeof window.MDE;
});

test("returns the chosen filename and folder", async () => {
  const choice = chooseDriveExport("Notes.md");
  const screen = await render(SaveToDriveDialog);

  await screen.getByLabelText("File name").fill("Plan.md");
  (window.MDE as unknown as { pickDriveFolder: () => Promise<{ id: string; name: string }> }).pickDriveFolder = async () => ({
    id: "folder-1",
    name: "Projects",
  });
  await screen.getByRole("button", { name: "Choose folder…" }).click();
  await expect.element(screen.getByText("Folder: Projects")).toBeVisible();

  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect(choice).resolves.toEqual({ name: "Plan.md", parentFolderId: "folder-1", parentFolderName: "Projects" });
});

test("cancel resolves null", async () => {
  const choice = chooseDriveExport("Notes.md");
  const screen = await render(SaveToDriveDialog);

  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect(choice).resolves.toBeNull();
});

test("Escape resolves null", async () => {
  const choice = chooseDriveExport("Notes.md");
  await render(SaveToDriveDialog);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await expect(choice).resolves.toBeNull();
});

test("Save is disabled for an empty filename", async () => {
  chooseDriveExport("Notes.md");
  const screen = await render(SaveToDriveDialog);

  await screen.getByLabelText("File name").fill("   ");
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});
