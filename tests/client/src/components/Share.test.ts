import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import Share from "../../../../client/src/components/Share.svelte";
import { shareModalOpen, shareAccess } from "../../../../client/src/stores/share";
import { githubUsername } from "../../../../client/src/stores/github";
import { activeIdStore } from "../../../../client/src/stores/docs";
import { enterCollabRoom, leaveCollabRoom, setChosenMode } from "../../../../client/src/stores/collabMode";

beforeEach(() => {
  window.MDE = { formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  shareModalOpen.set(true);
  shareAccess.set(null);
  githubUsername.set(null);
  leaveCollabRoom();
  activeIdStore.set("d1");
  for (const id of ["shareBtn", "shareDropdownBtn"]) {
    document.getElementById(id)?.remove();
    const b = document.createElement("button");
    b.id = id;
    document.body.appendChild(b);
  }
});

test("CV2-2: #shareBtn / #shareDropdownBtn disabled in Viewing or for a viewer / reviewer; enabled otherwise", async () => {
  await render(Share);
  const share = () => document.getElementById("shareBtn") as HTMLButtonElement;
  const dropdown = () => document.getElementById("shareDropdownBtn") as HTMLButtonElement;

  await expect.poll(() => share().disabled).toBe(false); // plain local doc

  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => share().disabled).toBe(true);
  expect(dropdown().disabled).toBe(true);

  enterCollabRoom("r2", "reviewer", false);
  await expect.poll(() => share().disabled).toBe(true);

  enterCollabRoom("r3", "editor", false); // non-owner editor keeps it
  await expect.poll(() => share().disabled).toBe(false);

  setChosenMode("viewing"); // editor, but Viewing mode
  await expect.poll(() => share().disabled).toBe(true);

  setChosenMode("editing");
  activeIdStore.set(null); // no active doc
  await expect.poll(() => share().disabled).toBe(true);
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

test("CV2-5: an owner with pending requests sees a Requests section with the note", async () => {
  shareAccess.set({
    owner: "alice",
    generalAccess: "anyone",
    requireAccount: false,
    role: "viewer",
    invited: [],
    accessRequests: [{ username: "bob", message: "need to fix a typo", createdAt: 1 }],
  });
  githubUsername.set("alice");
  enterCollabRoom("rq1", "editor", true); // collabIsOwner → true

  const screen = await render(Share);
  await expect.element(screen.getByText("Requests")).toBeVisible();
  await expect.element(screen.getByText("need to fix a typo")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect.element(screen.getByLabelText("Deny bob")).toBeVisible();
});

test("CV2-5: no Requests section for a non-owner even if the payload somehow carries it", async () => {
  shareAccess.set({
    owner: "alice",
    generalAccess: "anyone",
    requireAccount: false,
    role: "viewer",
    invited: [],
    accessRequests: [{ username: "bob", message: "", createdAt: 1 }],
  });
  githubUsername.set("bob");
  enterCollabRoom("rq2", "viewer", false);

  const screen = await render(Share);
  expect(screen.container.textContent).not.toContain("Requests");
});
