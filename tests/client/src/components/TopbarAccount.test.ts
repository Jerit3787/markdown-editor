import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import TopbarAccount from "../../../../client/src/components/TopbarAccount.svelte";
import { githubUsername } from "../../../../client/src/stores/github";
import { settingsModalOpen } from "../../../../client/src/stores/settingsModal";

beforeEach(() => {
  githubUsername.set(null);
  settingsModalOpen.set(false);
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

test("signed in: the button opens a menu with a header, Settings, and Sign out", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLImageElement;
  expect(img.src).toContain("github.com/octocat.png");

  await screen.getByRole("button", { name: "octocat" }).click();
  expect(screen.container.querySelector(".topbar-account-header-name")?.textContent).toContain("octocat");
  await expect.element(screen.getByRole("menuitem", { name: /settings/i })).toBeVisible();
  await expect.element(screen.getByRole("menuitem", { name: /sign out/i })).toBeVisible();
});

test("signed in: Settings item sets settingsModalOpen true", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: "octocat" }).click();
  await screen.getByRole("menuitem", { name: /settings/i }).click();
  expect(get(settingsModalOpen)).toBe(true);
});

test("signed in: Sign out POSTs to logout", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: "octocat" }).click();
  await screen.getByRole("menuitem", { name: /sign out/i }).click();
  expect(fetch).toHaveBeenCalledWith("/api/auth/github/logout", { method: "POST" });
});

test("signed out: the button opens a menu with Sign in with GitHub + Settings", async () => {
  const openSpy = vi.fn();
  window.MDE = new Proxy(
    { openGithubSignInPopup: openSpy },
    { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? vi.fn() },
  ) as unknown as typeof window.MDE;
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: /account/i }).click();

  expect(screen.container.querySelector(".topbar-account-header-name")?.textContent).toContain("Not signed in");
  await screen.getByRole("menuitem", { name: /sign in with github/i }).click();
  expect(openSpy).toHaveBeenCalled();
});

test("signed out: Settings item is present and sets the store", async () => {
  const screen = await render(TopbarAccount);
  await screen.getByRole("button", { name: /account/i }).click();
  await screen.getByRole("menuitem", { name: /settings/i }).click();
  expect(get(settingsModalOpen)).toBe(true);
});

test("signed in: an avatar load error falls back to the person glyph in the button", async () => {
  githubUsername.set("ghost");
  const screen = await render(TopbarAccount);
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLImageElement;
  img.dispatchEvent(new Event("error"));
  await expect.poll(() => screen.container.querySelector("img.topbar-account-avatar")).toBeNull();
  expect(screen.container.querySelector('.topbar-account-btn use[href="#icon-user"]')).not.toBeNull();
});
