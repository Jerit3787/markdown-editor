// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import "fake-indexeddb/auto";
import { render } from "vitest-browser-svelte";
import LinkDriveModal from "../../../../client/src/components/LinkDriveModal.svelte";
import { linkDriveModalOpen } from "../../../../client/src/stores/driveSync";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";
import { docsStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  localStorage.clear();
  window.MDE = {} as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "My Notes", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docsStore.set([{ id: "d1", name: "Plan", content: "# Plan", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  linkDriveModalOpen.set(true);
});

afterEach(() => vi.unstubAllGlobals());

test("creates a Drive folder named after the workspace and pushes the docs", async () => {
  let pushBody: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/drive/folder") {
        return new Response(JSON.stringify({ folderId: "folder-1", folderName: "My Notes" }), { status: 200 });
      }
      if (u.includes("/tree")) {
        return new Response(JSON.stringify({ folderId: "folder-1", folderName: "My Notes", workspaceId: "w1", entries: [] }), { status: 200 });
      }
      if (u.includes("/push")) {
        pushBody = JSON.parse(String(init!.body));
        return new Response(
          JSON.stringify({
            results: pushBody.creates.map((create: any, i: number) => ({ path: create.path, op: "create", ok: true, fileId: `f${i}`, rev: `r${i}` })),
            synced: pushBody.creates.length,
            failed: 0,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );

  const screen = await render(LinkDriveModal);
  await expect.element(screen.getByLabelText("Folder name")).toHaveValue("My Notes");
  await screen.getByRole("button", { name: "Create folder" }).click();

  await expect.poll(() => get(workspacesStore)[0]!.driveLink?.folderId).toBe("folder-1");
  await expect.poll(() => pushBody?.creates?.[0]?.path).toBe("Plan.md");
  await expect.poll(() => get(linkDriveModalOpen)).toBe(false);
});

test("Cancel closes without creating anything", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const screen = await render(LinkDriveModal);
  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(get(linkDriveModalOpen)).toBe(false);
});
