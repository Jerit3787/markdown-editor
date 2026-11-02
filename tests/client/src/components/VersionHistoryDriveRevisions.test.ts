import "fake-indexeddb/auto";
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import VersionHistory from "../../../../client/src/components/VersionHistory.svelte";
import { versionHistoryOpen } from "../../../../client/src/stores/versionHistory";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { deleteHistory, maybeSnapshotVersion } from "../../../../client/src/history";

const DOC_ID = "vh-drive-doc";
const DRIVE_OLD = "# From Drive\n\nan older revision\n";

let dispatched: { from: number; to: number; insert: string }[];

function stubFetch(extra?: (url: string) => Response | undefined) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const custom = extra?.(u);
    if (custom) return custom;
    if (u.endsWith("/revisions")) {
      return new Response(
        JSON.stringify({
          revisions: [
            { revId: "rev-2", modifiedTime: "2026-09-02T10:00:00Z", author: "Alice" },
            { revId: "rev-1", modifiedTime: "2026-09-01T10:00:00Z", author: "Bob" },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/revisions/rev-2")) return new Response(JSON.stringify({ contentBase64: btoa(DRIVE_OLD) }), { status: 200 });
    return new Response("Not Found", { status: 404 });
  });
}

beforeEach(async () => {
  dispatched = [];
  await deleteHistory(DOC_ID);
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0, driveLink: { folderId: "folder-1", folderName: "Notes" } }]);
  docsStore.set([
    {
      id: DOC_ID,
      name: "Test",
      content: "# Local head\n",
      updatedAt: 0,
      createdAt: 0,
      workspaceId: "w1",
      driveFileId: "file-1",
      drivePath: "Test.md",
    },
  ]);
  activeIdStore.set(DOC_ID);
  versionHistoryOpen.set(false);
  window.MDE = {
    getEditor: () => ({
      state: { readOnly: false, doc: { length: 12, toString: () => "# Local head\n" } },
      dispatch: (tr: { changes: { from: number; to: number; insert: string } }) => dispatched.push(tr.changes),
    }),
    formatRelativeTime: () => "just now",
    updatePreview: vi.fn(),
  } as unknown as typeof window.MDE;
});

test("DRIVE-VH-1: Drive revisions appear in the timeline", async () => {
  vi.stubGlobal("fetch", stubFetch());
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await expect.poll(() => screen.container.querySelectorAll(".version-history-row").length).toBe(2);
  await expect.element(screen.getByText(/Google Drive revision/).first()).toBeVisible();
  await expect.element(screen.getByLabelText("Edited by Alice")).toBeVisible();
  vi.unstubAllGlobals();
});

test("DRIVE-VH-2: selecting a Drive revision loads its content and Diff works", async () => {
  vi.stubGlobal("fetch", stubFetch());
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await screen
    .getByText(/Google Drive revision/)
    .first()
    .click();
  await screen.getByRole("button", { name: "Diff" }).click();

  await expect.poll(() => screen.container.querySelector(".diff-view")?.textContent ?? "").toContain("an older revision");
  vi.unstubAllGlobals();
});

test("DRIVE-VH-3: restoring a Drive revision dispatches its content", async () => {
  await maybeSnapshotVersion(DOC_ID, "# Local head\n", 2_000_000_000_000);
  vi.stubGlobal("fetch", stubFetch());
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await screen
    .getByText(/Google Drive revision/)
    .first()
    .click();
  await expect.poll(() => screen.container.querySelector(".version-history-preview")?.textContent ?? "").toContain("an older revision");

  const restoreBtn = screen.getByRole("button", { name: "Restore this version" });
  await expect.element(restoreBtn).not.toBeDisabled();
  await restoreBtn.click();

  await expect.poll(() => dispatched.at(-1)?.insert).toBe(DRIVE_OLD);
  await expect.poll(() => get(versionHistoryOpen)).toBe(false);
  vi.unstubAllGlobals();
});

test("DRIVE-VH-4: a doc linked to both GitHub and Drive shows both timelines", async () => {
  workspacesStore.set([
    {
      id: "w1",
      name: "WS",
      createdAt: 0,
      updatedAt: 0,
      driveLink: { folderId: "folder-1", folderName: "Notes" },
      repoLink: { owner: "octocat", repo: "notes", branch: "main" },
    },
  ]);
  docsStore.set([
    {
      id: DOC_ID,
      name: "Test",
      content: "# Local head\n",
      updatedAt: 0,
      createdAt: 0,
      workspaceId: "w1",
      driveFileId: "file-1",
      drivePath: "Test.md",
      repoPath: "Test.md",
    },
  ]);
  window.MDE.githubSessionReady = Promise.resolve();
  window.MDE.githubUsername = "octocat";
  vi.stubGlobal(
    "fetch",
    stubFetch((u) => {
      if (u.includes("/commits")) {
        return new Response(
          JSON.stringify([
            {
              sha: "commit-sha-1",
              commit: { message: "Update from Markdown Editor", author: { name: "octocat", date: "2026-09-03T10:00:00Z" } },
              html_url: "https://github.com/x",
            },
          ]),
          { status: 200 },
        );
      }
      return undefined;
    }),
  );
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await expect.element(screen.getByText("Update from Markdown Editor")).toBeVisible();
  await expect.element(screen.getByText(/Google Drive revision/).first()).toBeVisible();
  vi.unstubAllGlobals();
});

test("DRIVE-VH-5: a Drive revisions failure still leaves local history usable", async () => {
  await maybeSnapshotVersion(DOC_ID, "# Local head\n", 1_700_000_000_000);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unauthorized", { status: 401 })),
  );
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await expect.poll(() => screen.container.querySelectorAll(".version-history-row").length).toBeGreaterThan(0);
  expect(screen.container.textContent).not.toContain("No versions yet");
  vi.unstubAllGlobals();
});
