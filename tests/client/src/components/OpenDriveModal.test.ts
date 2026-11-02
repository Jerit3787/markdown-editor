// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import "fake-indexeddb/auto";
import { render } from "vitest-browser-svelte";
import OpenDriveModal from "../../../../client/src/components/OpenDriveModal.svelte";
import { openDriveModalOpen } from "../../../../client/src/stores/driveSync";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  localStorage.clear();
  window.MDE = { formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  workspacesStore.set([]);
  activeWorkspaceIdStore.set(null);
  docsStore.set([]);
  activeIdStore.set(null);
  openDriveModalOpen.set(true);
});

afterEach(() => vi.unstubAllGlobals());

test("lists the app's Drive folders and opens one as a new workspace", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u === "/api/drive/folders") {
        return new Response(
          JSON.stringify({ folders: [{ folderId: "folder-1", folderName: "Notes", workspaceId: "old", modifiedTime: "2026-01-01T00:00:00Z" }] }),
          {
            status: 200,
          },
        );
      }
      if (u.includes("/tree")) {
        return new Response(JSON.stringify({ folderId: "folder-1", folderName: "Notes", workspaceId: null, entries: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );

  const screen = await render(OpenDriveModal);
  await expect.element(screen.getByText("Notes")).toBeVisible();
  await screen.getByRole("button", { name: /Notes/ }).click();

  await expect.poll(() => get(workspacesStore).length).toBe(1);
  expect(get(workspacesStore)[0]).toMatchObject({ name: "Notes", driveLink: { folderId: "folder-1", folderName: "Notes" } });
  await expect.poll(() => get(openDriveModalOpen)).toBe(false);
});

test("shows an empty state when there are no app folders", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ folders: [] }), { status: 200 })),
  );
  const screen = await render(OpenDriveModal);
  await expect.element(screen.getByText("No synced folders yet", { exact: false })).toBeVisible();
});
