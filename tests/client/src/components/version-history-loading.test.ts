import "fake-indexeddb/auto";
import { test, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

// Force the history read to reject (IndexedDB unavailable/quota) while
// keeping every other history export real.
vi.mock("../../../../client/src/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../client/src/history")>();
  return {
    ...actual,
    listVersions: vi.fn(async () => {
      throw new Error("indexeddb unavailable");
    }),
    listSharedVersions: vi.fn(async () => {
      throw new Error("indexeddb unavailable");
    }),
  };
});

import VersionHistory from "../../../../client/src/components/VersionHistory.svelte";
import { versionHistoryOpen } from "../../../../client/src/stores/versionHistory";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { toasts } from "../../../../client/src/stores/toast";

beforeEach(() => {
  window.MDE = { getEditor: () => ({ state: { readOnly: false } }), formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([{ id: "vh-fail-doc", name: "Test", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set("vh-fail-doc");
  toasts.set([]);
  versionHistoryOpen.set(false);
});

test("shows the empty state instead of a permanent spinner when loading history rejects", async () => {
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await expect.element(screen.getByText("No versions yet")).toBeVisible();
  expect(get(toasts).some((t) => t.type === "error")).toBe(true);
});
