import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import CommentsPanel from "../../../../client/src/components/CommentsPanel.svelte";
import { commentsPanelOpen } from "../../../../client/src/stores/commentsPanel";
import { enterCollabRoom, leaveCollabRoom } from "../../../../client/src/stores/collabMode";
import { activeIdStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  leaveCollabRoom();
  commentsPanelOpen.set(false);
  activeIdStore.set("d1");
  document.getElementById("commentsBtn")?.remove();
  const btn = document.createElement("button");
  btn.id = "commentsBtn";
  document.body.appendChild(btn);
});

test("CV2-1b: the comments button is disabled (not hidden) in Viewing, and the panel forced closed", async () => {
  const btn = document.getElementById("commentsBtn") as HTMLButtonElement;
  commentsPanelOpen.set(true);
  await render(CommentsPanel);

  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => btn.disabled).toBe(true);
  expect(btn.hasAttribute("hidden")).toBe(false);
  await expect.poll(() => get(commentsPanelOpen)).toBe(false);

  enterCollabRoom("r2", "reviewer", false);
  await expect.poll(() => btn.disabled).toBe(false);

  enterCollabRoom("r3", "editor", true);
  await expect.poll(() => btn.disabled).toBe(false);
});

test("CV2-1b: the comments button is disabled when there is no active doc", async () => {
  const btn = document.getElementById("commentsBtn") as HTMLButtonElement;
  await render(CommentsPanel);
  await expect.poll(() => btn.disabled).toBe(false);
  activeIdStore.set(null);
  await expect.poll(() => btn.disabled).toBe(true);
});
