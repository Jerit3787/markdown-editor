import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import TopbarAccount from "../../../../client/src/components/TopbarAccount.svelte";
import { githubUsername } from "../../../../client/src/stores/github";

beforeEach(() => {
  githubUsername.set(null);
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  // Default: a fetch that never resolves, so signOut() never reaches its
  // location.reload() (which would reload the test runner page).
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

test("signed out: renders a person-icon button that opens the sign-in popup", async () => {
  const openSpy = vi.fn();
  window.MDE = new Proxy(
    { openGithubSignInPopup: openSpy },
    { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? vi.fn() },
  ) as unknown as typeof window.MDE;
  const screen = await render(TopbarAccount);
  const btn = screen.getByRole("button", { name: /sign in/i });
  await expect.element(btn).toBeVisible();
  expect(screen.container.querySelector('use[href="#icon-user"]')).not.toBeNull();
  await btn.click();
  expect(openSpy).toHaveBeenCalled();
});

test("signed in: renders the avatar image and a Sign out item that POSTs to logout", async () => {
  githubUsername.set("octocat");
  const screen = await render(TopbarAccount);
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLImageElement;
  expect(img).not.toBeNull();
  expect(img.src).toContain("github.com/octocat.png");

  await screen.getByRole("button", { name: "octocat" }).click();
  await screen.getByRole("menuitem", { name: /sign out/i }).click();
  expect(fetch).toHaveBeenCalledWith("/api/auth/github/logout", { method: "POST" });
});

test("signed in: an avatar load error falls back to the person glyph", async () => {
  githubUsername.set("ghost");
  const screen = await render(TopbarAccount);
  const img = screen.container.querySelector("img.topbar-account-avatar") as HTMLImageElement;
  img.dispatchEvent(new Event("error"));
  await expect.poll(() => screen.container.querySelector("img.topbar-account-avatar")).toBeNull();
  expect(screen.container.querySelector('use[href="#icon-user"]')).not.toBeNull();
});
