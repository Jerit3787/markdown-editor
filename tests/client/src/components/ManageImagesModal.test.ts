import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

// removeImage() gates on confirmAction() — auto-confirm so the delete path runs.
vi.mock("../../../../client/src/stores/confirmDialog", () => ({
  confirmAction: () => Promise.resolve(true),
}));

import ManageImagesModal from "../../../../client/src/components/ManageImagesModal.svelte";
import { manageImagesModalOpen } from "../../../../client/src/stores/imagesModal";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { activeWorkspaceIdStore, workspacesStore } from "../../../../client/src/stores/workspaces";

const SMALL = "data:image/png;base64,AAAA";
const BIG = "data:image/png;base64," + "A".repeat(4000); // ~3 KB decoded

beforeEach(() => {
  window.MDE = {
    getEditor: () => ({ state: { doc: { toString: () => "![a](a.png)" } } }),
    updatePreview: vi.fn(),
  } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docsStore.set([{ id: "d1", name: "Doc", content: "![a](a.png)", updatedAt: 0, createdAt: 0, workspaceId: "w1", images: { "a.png": SMALL, "b.png": BIG } }]);
  activeIdStore.set("d1");
  manageImagesModalOpen.set(true);
});

test("IMG-13: each image row shows a human-readable size", async () => {
  const screen = await render(ManageImagesModal);
  const sizes = Array.from(screen.container.querySelectorAll(".image-size")).map((el) => el.textContent?.trim());
  expect(sizes.length).toBe(2);
  for (const s of sizes) expect(s).toMatch(/^\d+(\.\d+)?\s?(B|KB|MB)$/);
});

test("IMG-12: deleting an image row removes it from the doc's image map and the list", async () => {
  const screen = await render(ManageImagesModal);
  expect(screen.container.querySelectorAll(".image-item").length).toBe(2);

  await screen.getByRole("button", { name: "Delete a.png" }).click();

  expect(get(docsStore)[0].images).not.toHaveProperty("a.png");
  expect(get(docsStore)[0].images).toHaveProperty("b.png");
  await expect.poll(() => screen.container.querySelectorAll(".image-item").length).toBe(1);
});
