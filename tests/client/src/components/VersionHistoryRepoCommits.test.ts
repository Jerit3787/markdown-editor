import "fake-indexeddb/auto";
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import VersionHistory from "../../../../client/src/components/VersionHistory.svelte";
import { versionHistoryOpen } from "../../../../client/src/stores/versionHistory";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { deleteHistory, maybeSnapshotVersion } from "../../../../client/src/history";

// VER-16 / REPO-21 — Version History merges GitHub repo commits into the
// timeline, loads a commit's content, diffs it against Live, and restores
// from it. Driven with a fetch stub standing in for /api/repo/*.

const DOC_ID = "vh-repo-doc";
const COMMIT_BODY = "# From the repo\n\nedited on GitHub\n";

let dispatched: { from: number; to: number; insert: string }[];

function stubFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/commits")) {
      return new Response(
        JSON.stringify([
          {
            sha: "commit-sha-1",
            commit: { message: "Update from Markdown Editor", author: { name: "octocat", date: "2026-09-01T10:00:00Z" } },
            html_url: "https://github.com/x",
          },
        ]),
        { status: 200 },
      );
    }
    if (/\/contents\/Test\.md\?ref=commit-sha-1/.test(u)) {
      return new Response(JSON.stringify({ content: btoa(COMMIT_BODY), encoding: "base64" }), { status: 200 });
    }
    // .mde/history/<slug>.json and everything else → not there
    return new Response("Not Found", { status: 404 });
  });
}

beforeEach(async () => {
  dispatched = [];
  await deleteHistory(DOC_ID);
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "main" } }]);
  docsStore.set([{ id: DOC_ID, name: "Test", content: "# Local head\n", updatedAt: 0, createdAt: 0, workspaceId: "w1", repoPath: "Test.md" }]);
  activeIdStore.set(DOC_ID);
  versionHistoryOpen.set(false);
  window.MDE = {
    getEditor: () => ({
      state: { readOnly: false, doc: { length: 12, toString: () => "# Local head\n" } },
      dispatch: (tr: { changes: { from: number; to: number; insert: string } }) => dispatched.push(tr.changes),
    }),
    formatRelativeTime: () => "just now",
    githubSessionReady: Promise.resolve(),
    githubUsername: "octocat",
    updatePreview: vi.fn(),
  } as unknown as typeof window.MDE;
});

test("VER-16: a repo commit appears in the timeline alongside local history", async () => {
  await maybeSnapshotVersion(DOC_ID, "# Local head\n", 1_700_000_000_000);
  vi.stubGlobal("fetch", stubFetch());

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await expect.element(screen.getByText("Update from Markdown Editor")).toBeVisible();
  vi.unstubAllGlobals();
});

test("REPO-21: selecting the commit loads its content and Diff shows it as `before`", async () => {
  vi.stubGlobal("fetch", stubFetch());
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await screen.getByText("Update from Markdown Editor").click();
  await screen.getByRole("button", { name: "Diff" }).click();

  await expect.poll(() => screen.container.querySelector(".diff-view")?.textContent ?? "").toContain("From the repo");
  vi.unstubAllGlobals();
});

test("REPO-21: Restore from a commit dispatches the commit content into the editor", async () => {
  // A local snapshot newer than the commit, so the commit is not the
  // "current" entry (Restore is disabled for that one).
  await maybeSnapshotVersion(DOC_ID, "# Local head\n", 1_800_000_000_000);
  vi.stubGlobal("fetch", stubFetch());
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await screen.getByText("Update from Markdown Editor").click();
  // Wait for the commit content to actually load (selectVersion is async;
  // restore() no-ops while selectedContent is still undefined).
  await expect.poll(() => screen.container.querySelector(".version-history-preview")?.textContent ?? "").toContain("From the repo");

  const restoreBtn = screen.getByRole("button", { name: "Restore this version" });
  await expect.element(restoreBtn).not.toBeDisabled();
  await restoreBtn.click();

  await expect.poll(() => dispatched.at(-1)?.insert).toBe(COMMIT_BODY);
  await expect.poll(() => get(versionHistoryOpen)).toBe(false);
  vi.unstubAllGlobals();
});
