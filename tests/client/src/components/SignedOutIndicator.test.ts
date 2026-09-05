import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import SignedOutIndicator from "../../../../client/src/components/SignedOutIndicator.svelte";
import { identityUnverified } from "../../../../client/src/stores/share";

beforeEach(() => {
  identityUnverified.set(false);
  window.MDE = { requireGithubSignIn: vi.fn() } as unknown as typeof window.MDE;
});

test("renders nothing when identity is verified", async () => {
  const screen = await render(SignedOutIndicator);
  expect((await screen.getByRole("button").all()).length).toBe(0);
});

test("shows a signed-out indicator when identity is unverified", async () => {
  identityUnverified.set(true);
  const screen = await render(SignedOutIndicator);
  await expect.element(screen.getByRole("button", { name: "Signed out" })).toBeVisible();
});

test("clicking the indicator triggers the GitHub sign-in flow", async () => {
  identityUnverified.set(true);
  const screen = await render(SignedOutIndicator);
  await screen.getByRole("button", { name: "Signed out" }).click();
  expect(window.MDE.requireGithubSignIn).toHaveBeenCalledTimes(1);
});
