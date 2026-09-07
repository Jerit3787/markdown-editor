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

test("drive: File > Open shows 'Markdown from Google Drive' when the feature is configured, hides it otherwise", async () => {
  const { driveConfigured } = await import("../../../../client/src/stores/driveSync");
  driveConfigured.set(true);
  let screen = await render(MenuBar);
  expect(screen.container.querySelector("#menuOpenDrive")).not.toBeNull();

  driveConfigured.set(false);
  screen = await render(MenuBar);
  expect(screen.container.querySelector("#menuOpenDrive")).toBeNull();
  driveConfigured.set(true);
});

test("drive: the Open-Drive item shows the busy label and disables while importing", async () => {
  const { driveConfigured, driveImportBusyLabel } = await import("../../../../client/src/stores/driveSync");
  driveConfigured.set(true);
  driveImportBusyLabel.set("Importing…");
  const screen = await render(MenuBar);
  const btn = screen.container.querySelector("#menuOpenDrive") as HTMLButtonElement;
  expect(btn.textContent?.trim()).toBe("Importing…");
  expect(btn.disabled).toBe(true);
  driveImportBusyLabel.set(null);
});
