import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import MenuBar from "../../../../client/src/components/MenuBar.svelte";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";
import { unresolvedCommentCount } from "../../../../client/src/stores/commentsPanel";
import { pendingSuggestionCount } from "../../../../client/src/stores/suggestions";
import { enterCollabRoom, leaveCollabRoom, setChosenMode } from "../../../../client/src/stores/collabMode";

beforeEach(() => {
  leaveCollabRoom();
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
  pendingSuggestionCount.set(0);
});

test("CMT-16: the File-menu Comments entry badges unresolved comments + pending suggestions", async () => {
  unresolvedCommentCount.set(2);
  pendingSuggestionCount.set(1);
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

test("REPO-23: the File > Repo submenu shows the repo link and last-synced relative time", async () => {
  workspacesStore.set([
    { id: "w1", name: "WS", createdAt: 0, updatedAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "main" }, repoLastSyncedAt: 1_700_000_000_000 },
  ]);
  activeWorkspaceIdStore.set("w1");
  const screen = await render(MenuBar);

  const labels = Array.from(screen.container.querySelectorAll(".menu-section-label")).map((el) => el.textContent?.trim());
  expect(labels).toContain("octocat/notes");
  expect(labels).toContain("Synced just now"); // formatRelativeTime stub
});

test("REPO-23: no last-synced label when repoLastSyncedAt is unset", async () => {
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "main" } }]);
  activeWorkspaceIdStore.set("w1");
  const screen = await render(MenuBar);
  const labels = Array.from(screen.container.querySelectorAll(".menu-section-label")).map((el) => el.textContent?.trim());
  expect(labels.some((l) => l?.startsWith("Synced "))).toBe(false);
});

test("GIST-13: signed out — the plain Publish button is shown, the submenu is hidden", async () => {
  const { githubUsername } = await import("../../../../client/src/stores/github");
  githubUsername.set(null);
  const screen = await render(MenuBar);
  expect(screen.container.querySelector("#menuPublishSignedOut")!.hasAttribute("hidden")).toBe(false);
  expect(screen.container.querySelector("#publishSubmenu")!.hasAttribute("hidden")).toBe(true);
});

test("GIST-13: signed in — the submenu is shown, the plain button hidden", async () => {
  const { githubUsername } = await import("../../../../client/src/stores/github");
  githubUsername.set("octocat");
  const screen = await render(MenuBar);
  expect(screen.container.querySelector("#publishSubmenu")!.hasAttribute("hidden")).toBe(false);
  expect(screen.container.querySelector("#menuPublishSignedOut")!.hasAttribute("hidden")).toBe(true);
  githubUsername.set(null);
});

test("DRIVE-1: the Open > Google Drive item hides only when disconnected AND unconfigured", async () => {
  const { driveConnected, driveConfigured } = await import("../../../../client/src/stores/driveSync");

  driveConnected.set(false);
  driveConfigured.set(false);
  const screen = await render(MenuBar);
  const item = () => screen.container.querySelector("#menuOpenDrive")!;
  await expect.poll(() => item().hasAttribute("hidden")).toBe(true);

  driveConfigured.set(true); // configured but not connected — still offered (click starts connect)
  await expect.poll(() => item().hasAttribute("hidden")).toBe(false);

  driveConfigured.set(false);
  driveConnected.set(true); // connected — offered regardless
  await expect.poll(() => item().hasAttribute("hidden")).toBe(false);

  driveConnected.set(false);
  driveConfigured.set(true);
});

test("CV2-1: Viewing condenses the Edit menu (keeps Find/Copy) and hides Format/Insert; Suggesting keeps all three", async () => {
  const screen = await render(MenuBar);
  const hidden = (sel: string) => screen.container.querySelector(sel)?.hasAttribute("hidden");

  // editing / local — everything present
  expect(hidden("#editMenuBtn")).toBe(false);
  expect(hidden("#menuUndo")).toBe(false);

  enterCollabRoom("r1", "viewer", false); // → viewing
  await expect.poll(() => hidden("#formatMenuBtn")).toBe(true);
  expect(hidden("#insertMenuBtn")).toBe(true);
  expect(hidden("#editMenuBtn")).toBe(false); // Edit menu stays, condensed
  expect(hidden("#menuFind")).toBe(false);
  expect(hidden("#menuCopy")).toBe(false);
  expect(hidden("#menuUndo")).toBe(true);
  expect(hidden("#menuRedo")).toBe(true);
  expect(hidden("#menuFindReplace")).toBe(true);
  expect(hidden("#menuCut")).toBe(true);
  expect(hidden("#menuPaste")).toBe(true);
  // File / View / Help stay
  expect(hidden("#fileMenuBtn")).toBe(false);
  expect(hidden("#viewMenuBtn")).toBe(false);
  expect(hidden("#helpMenuBtn")).toBe(false);

  enterCollabRoom("r2", "reviewer", false); // → suggesting (a reviewer's default)
  await expect.poll(() => hidden("#formatMenuBtn")).toBe(false);
  expect(hidden("#insertMenuBtn")).toBe(false);
  expect(hidden("#menuUndo")).toBe(false);
});

test("CV2-1b: #menuComments is disabled (not hidden) in Viewing, enabled in Suggesting/Editing", async () => {
  const screen = await render(MenuBar);
  const el = () => screen.container.querySelector("#menuComments") as HTMLButtonElement;
  expect(el().disabled).toBe(false);
  enterCollabRoom("r1", "viewer", false);
  await expect.poll(() => el().disabled).toBe(true);
  expect(el().hasAttribute("hidden")).toBe(false);
  enterCollabRoom("r2", "reviewer", false);
  await expect.poll(() => el().disabled).toBe(false);
});

test("CV2-3: #menuVersionHistory is enabled only when effective mode is editing (or a plain local doc)", async () => {
  const screen = await render(MenuBar);
  const el = () => screen.container.querySelector("#menuVersionHistory") as HTMLButtonElement;
  expect(el().disabled).toBe(false); // local
  enterCollabRoom("r1", "editor", true);
  setChosenMode("suggesting");
  await expect.poll(() => el().disabled).toBe(true); // editor, but suggesting
  setChosenMode("viewing");
  await expect.poll(() => el().disabled).toBe(true);
  setChosenMode("editing");
  await expect.poll(() => el().disabled).toBe(false);
  enterCollabRoom("r2", "viewer", false);
  await expect.poll(() => el().disabled).toBe(true);
});

test("CV2-4: #menuDeleteDoc is enabled only for owner-in-editing (or a plain local doc)", async () => {
  const screen = await render(MenuBar);
  const el = () => screen.container.querySelector("#menuDeleteDoc") as HTMLButtonElement;
  expect(el().disabled).toBe(false); // local
  enterCollabRoom("r1", "editor", false); // non-owner editor
  await expect.poll(() => el().disabled).toBe(true);
  enterCollabRoom("r2", "editor", true); // owner
  setChosenMode("editing");
  await expect.poll(() => el().disabled).toBe(false);
  setChosenMode("viewing");
  await expect.poll(() => el().disabled).toBe(true);
});

test("A1/A2: Publish + GitHub Repo are hidden for a non-owner shared session, shown for owner and local", async () => {
  const { githubUsername } = await import("../../../../client/src/stores/github");
  githubUsername.set("octocat");
  const screen = await render(MenuBar);
  const hidden = (sel: string) => screen.container.querySelector(sel)?.hasAttribute("hidden");
  const repoSubmenu = () =>
    [...screen.container.querySelectorAll("#fileMenu .menu-submenu-trigger")].find((b) => /GitHub Repo/.test(b.textContent ?? ""))?.closest(".menu-submenu");

  // Local (no collab role) — visible.
  expect(hidden("#publishSubmenu")).toBe(false);
  expect(repoSubmenu()?.hasAttribute("hidden")).toBe(false);

  // Shared, NOT owner — hidden (even for an editor).
  enterCollabRoom("r1", "editor", false);
  await expect.poll(() => hidden("#publishSubmenu")).toBe(true);
  expect(hidden("#menuPublishSignedOut")).toBe(true);
  expect(repoSubmenu()?.hasAttribute("hidden")).toBe(true);

  // Shared AND owner — visible again.
  enterCollabRoom("r2", "editor", true);
  await expect.poll(() => hidden("#publishSubmenu")).toBe(false);
  expect(repoSubmenu()?.hasAttribute("hidden")).toBe(false);

  githubUsername.set(null);
});
