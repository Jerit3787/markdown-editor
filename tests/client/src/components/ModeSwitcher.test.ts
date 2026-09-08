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

test("UI-4: the label is hidden when the collaborator can switch modes, shown when they can't", async () => {
  enterCollabRoom("r1", "editor", true); // 3 modes
  let screen = await render(ModeSwitcher);
  await expect.poll(() => screen.container.querySelector(".mode-switcher-label")).toBeNull();

  leaveCollabRoom();
  enterCollabRoom("r3", "viewer", false); // 1 mode
  screen = await render(ModeSwitcher);
  await expect.poll(() => screen.container.querySelector(".mode-switcher-label")?.textContent?.trim()).toBe("Viewing");
});

test("D-modedesc: the dropdown shows a one-line description under each mode", async () => {
  enterCollabRoom("r1", "editor", true);
  const screen = await render(ModeSwitcher);
  await screen.getByRole("button", { name: /Editing/i }).click();
  expect(screen.container.textContent).toContain("Edit document directly");
  expect(screen.container.textContent).toContain("Edits become suggestions");
  expect(screen.container.textContent).toContain("Read or print final document");
});

test("v2: each dropdown item has the icon and the two-line text block as siblings", async () => {
  // Structural only — the flex layout that puts them on one row is
  // verified against the real stylesheet in the e2e suite
  // (tests/e2e/local/topbar-chrome.spec.ts), since component tests run
  // without the app CSS or the #topbarActionsCol wrapper the rule scopes to.
  enterCollabRoom("r1", "editor", true);
  const screen = await render(ModeSwitcher);
  await screen.getByRole("button", { name: /Editing/i }).click();

  const item = screen.container.querySelector(".mode-switcher-item") as HTMLElement;
  expect(item.querySelector(":scope > .icon")).not.toBeNull();
  expect(item.querySelector(":scope > .mode-switcher-item-text > .mode-switcher-item-label")?.textContent).toBe("Editing");
  expect(item.querySelector(":scope > .mode-switcher-item-text > .mode-switcher-desc")?.textContent).toBe("Edit document directly");
});
