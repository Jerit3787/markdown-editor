import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import WorkspaceAccessBanner from "../../../../client/src/components/WorkspaceAccessBanner.svelte";
import { workspaceAccessDenied } from "../../../../client/src/stores/share";

beforeEach(() => {
  workspaceAccessDenied.set(null);
  window.MDE = { requireGithubSignIn: vi.fn() } as unknown as typeof window.MDE;
});

test("renders nothing when access isn't denied", async () => {
  const screen = await render(WorkspaceAccessBanner);
  expect((await screen.getByRole("button").all()).length).toBe(0);
});

test("shows a sign-in prompt and button for 'no-session'", async () => {
  workspaceAccessDenied.set("no-session");
  const screen = await render(WorkspaceAccessBanner);
  await expect.element(screen.getByText(/sign in to reconnect/i)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("clicking Sign in triggers the GitHub sign-in flow", async () => {
  workspaceAccessDenied.set("no-session");
  const screen = await render(WorkspaceAccessBanner);
  await screen.getByRole("button", { name: "Sign in" }).click();
  expect(window.MDE.requireGithubSignIn).toHaveBeenCalledTimes(1);
});

test("shows a no-button message for 'no-access', not a sign-in button", async () => {
  workspaceAccessDenied.set("no-access");
  const screen = await render(WorkspaceAccessBanner);
  await expect.element(screen.getByText(/ask the owner/i)).toBeVisible();
  expect((await screen.getByRole("button").all()).length).toBe(0);
});
