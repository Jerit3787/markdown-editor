import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import MenuBar from "../../../../client/src/components/MenuBar.svelte";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";
import { unresolvedCommentCount } from "../../../../client/src/stores/commentsPanel";

beforeEach(() => {
  // MenuBar's onMount/$effects reach through the bridge for dropdown/submenu
  // wiring — stub the whole surface so the component mounts.
  window.MDE = new Proxy(
    { formatRelativeTime: () => "just now" },
    { get: (target, prop) => (prop in target ? (target as Record<string, unknown>)[prop as string] : vi.fn()) },
  ) as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set("d1");
  unresolvedCommentCount.set(0);
});

test("CMT-16: the File-menu Comments entry shows the unresolved-count badge", async () => {
  unresolvedCommentCount.set(3);
  const screen = await render(MenuBar);
  const badge = () => screen.container.querySelector("#menuComments .menu-badge");
  await expect.poll(() => badge()?.textContent?.trim()).toBe("3");
});

test("CMT-16: no badge when the count is zero", async () => {
  const screen = await render(MenuBar);
  expect(screen.container.querySelector("#menuComments .menu-badge")).toBeNull();
});

test("CMT-16: the badge caps at 99+", async () => {
  unresolvedCommentCount.set(150);
  const screen = await render(MenuBar);
  await expect.poll(() => screen.container.querySelector("#menuComments .menu-badge")?.textContent?.trim()).toBe("99+");
});
