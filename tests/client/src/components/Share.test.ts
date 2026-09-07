import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import Share from "../../../../client/src/components/Share.svelte";
import { shareModalOpen, shareAccess } from "../../../../client/src/stores/share";
import { githubUsername } from "../../../../client/src/stores/github";

beforeEach(() => {
  window.MDE = { formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  shareModalOpen.set(true);
  shareAccess.set(null);
  githubUsername.set(null);
});

test("COLLAB-23: a joined non-owner sees disabled controls, the owner-only hint, and the real owner", async () => {
  shareAccess.set({
    owner: "alice",
    generalAccess: "anyone",
    requireAccount: false,
    role: "editor",
    invited: [{ username: "bob", role: "editor" }],
  });
  githubUsername.set("bob");

  const screen = await render(Share);

  await expect.element(screen.getByLabelText("General access")).toBeDisabled();
  await expect.element(screen.getByLabelText("Access level for people with the link")).toBeDisabled();
  await expect.element(screen.getByLabelText("Add people by GitHub username")).toBeDisabled();
  await expect.element(screen.getByText("Only the workspace's owner can change who has access.")).toBeVisible();
  await expect.element(screen.getByText("alice")).toBeVisible(); // owner row shows the real owner
  await expect.element(screen.getByRole("button", { name: "Copy link" })).not.toBeDisabled();
});

test("COLLAB-23: the owner themselves gets live controls and no hint", async () => {
  shareAccess.set({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
  githubUsername.set("alice");

  const screen = await render(Share);

  await expect.element(screen.getByLabelText("General access")).not.toBeDisabled();
  expect(screen.container.textContent).not.toContain("Only the workspace's owner can change");
});

test("COLLAB-23: a not-yet-claimed workspace (owner null) is treated as the local user's own", async () => {
  shareAccess.set({ owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
  githubUsername.set("bob");

  const screen = await render(Share);

  await expect.element(screen.getByLabelText("General access")).not.toBeDisabled();
  await expect.element(screen.getByText("bob")).toBeVisible(); // owner row falls back to the local user
});
