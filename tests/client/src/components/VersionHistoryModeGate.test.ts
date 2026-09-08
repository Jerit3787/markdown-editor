import "fake-indexeddb/auto";
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import VersionHistory from "../../../../client/src/components/VersionHistory.svelte";
import { versionHistoryOpen } from "../../../../client/src/stores/versionHistory";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { enterCollabRoom, leaveCollabRoom, setChosenMode } from "../../../../client/src/stores/collabMode";

beforeEach(() => {
  window.MDE = new Proxy(
    { formatRelativeTime: () => "just now" },
    { get: (t, p) => (p in t ? (t as Record<string, unknown>)[p as string] : vi.fn()) },
  ) as unknown as typeof window.MDE;
  leaveCollabRoom();
  versionHistoryOpen.set(false);
  document.getElementById("versionHistoryBtn")?.remove();
  const btn = document.createElement("button");
  btn.id = "versionHistoryBtn";
  document.body.appendChild(btn);
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([{ id: "d1", name: "D", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set("d1");
});

test("CV2-3: #versionHistoryBtn is enabled only in editing mode; open() no-ops otherwise", async () => {
  const btn = () => document.getElementById("versionHistoryBtn") as HTMLButtonElement;
  await render(VersionHistory);
  await expect.poll(() => btn().disabled).toBe(false); // plain local doc

  enterCollabRoom("r1", "editor", true);
  setChosenMode("viewing");
  await expect.poll(() => btn().disabled).toBe(true);
  btn().click();
  expect(get(versionHistoryOpen)).toBe(false); // open() early-returned

  setChosenMode("suggesting");
  await expect.poll(() => btn().disabled).toBe(true);

  setChosenMode("editing");
  await expect.poll(() => btn().disabled).toBe(false);

  enterCollabRoom("r2", "viewer", false);
  await expect.poll(() => btn().disabled).toBe(true);
});

test("CV2-3: #versionHistoryBtn is disabled when there is no active doc", async () => {
  const btn = () => document.getElementById("versionHistoryBtn") as HTMLButtonElement;
  await render(VersionHistory);
  await expect.poll(() => btn().disabled).toBe(false);
  activeIdStore.set(null);
  await expect.poll(() => btn().disabled).toBe(true);
});
