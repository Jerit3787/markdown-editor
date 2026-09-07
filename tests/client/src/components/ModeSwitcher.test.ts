import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import ModeSwitcher from "../../../../client/src/components/ModeSwitcher.svelte";
import { enterCollabRoom, leaveCollabRoom, effectiveMode } from "../../../../client/src/stores/collabMode";

beforeEach(() => {
  localStorage.clear();
  leaveCollabRoom();
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
});

test("renders nothing outside a shared workspace", async () => {
  const screen = await render(ModeSwitcher);
  await expect.poll(() => screen.container.textContent?.trim()).toBe("");
});

test("an editor sees all three modes and picking one applies it", async () => {
  enterCollabRoom("r1", "editor", true);
  const screen = await render(ModeSwitcher);
  await screen.getByRole("button", { name: /Editing/i }).click();
  await screen.getByRole("menuitem", { name: /Viewing/i }).click();
  expect(get(effectiveMode)).toBe("viewing");
});

test("a reviewer sees only Suggesting + Viewing", async () => {
  enterCollabRoom("r2", "reviewer", false);
  const screen = await render(ModeSwitcher);
  await screen.getByRole("button").click();
  const items = await screen.getByRole("menuitem").all();
  expect(items.length).toBe(2);
  expect((await screen.getByRole("menuitem", { name: /Editing/i }).all()).length).toBe(0);
});

test("a viewer's switcher shows Viewing and its menu is inert", async () => {
  enterCollabRoom("r3", "viewer", false);
  const screen = await render(ModeSwitcher);
  await expect.element(screen.getByRole("button", { name: /Viewing/i })).toBeVisible();
  await screen.getByRole("button").click();
  expect((await screen.getByRole("menuitem").all()).length).toBe(0);
});
