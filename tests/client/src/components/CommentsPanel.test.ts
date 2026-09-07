import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import CommentsPanel from "../../../../client/src/components/CommentsPanel.svelte";
import { commentsPanelOpen } from "../../../../client/src/stores/commentsPanel";
import { enterCollabRoom, leaveCollabRoom } from "../../../../client/src/stores/collabMode";

beforeEach(() => {
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  leaveCollabRoom();
  commentsPanelOpen.set(false);
  document.getElementById("commentsBtn")?.remove();
  const btn = document.createElement("button");
  btn.id = "commentsBtn";
  document.body.appendChild(btn);
});

test("A4: the comments button is hidden and the panel forced closed in Viewing", async () => {
  const btn = document.getElementById("commentsBtn")!;
  commentsPanelOpen.set(true);
  await render(CommentsPanel);

  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => btn.hasAttribute("hidden")).toBe(true);
  await expect.poll(() => get(commentsPanelOpen)).toBe(false);

  enterCollabRoom("r2", "editor", true);
  await expect.poll(() => btn.hasAttribute("hidden")).toBe(false);
});
