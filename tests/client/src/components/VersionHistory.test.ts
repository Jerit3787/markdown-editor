import "fake-indexeddb/auto";
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import VersionHistory from "../../../../client/src/components/VersionHistory.svelte";
import { versionHistoryOpen } from "../../../../client/src/stores/versionHistory";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { maybeSnapshotVersion, deleteHistory } from "../../../../client/src/history";

const DOC_ID = "vh-test-doc";

beforeEach(async () => {
  window.MDE = { getEditor: () => ({ state: { readOnly: false } }), formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  await deleteHistory(DOC_ID);
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([{ id: DOC_ID, name: "Test", content: "v3", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set(DOC_ID);
  versionHistoryOpen.set(false);
});

test("groups snapshots from the same session into one collapsible row", async () => {
  await maybeSnapshotVersion(DOC_ID, "v0", 1_000);
  await maybeSnapshotVersion(DOC_ID, "v1", 1_000 + 35 * 1000);
  await maybeSnapshotVersion(DOC_ID, "v2", 1_000 + 70 * 1000);

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await expect.element(screen.getByText(/3 edits/)).toBeVisible();
  // Nested rows use formatTimestamp's full toLocaleString() (includes the
  // year); the session label uses a short month/day format with no year
  // (see formatSessionLabel below) — "1970" (these snapshots' epoch-ms
  // timestamps land on Jan 1 1970) only ever appears in a nested row's
  // own text, never in the collapsed session header's label, so counting
  // it is a locale-format-independent way to detect nested rows without
  // depending on exact time-string punctuation.
  expect((await screen.getByText(/1970/).all()).length).toBe(0);
});

test("expanding a session reveals its nested snapshots, collapsing hides them again", async () => {
  await maybeSnapshotVersion(DOC_ID, "v0", 1_000);
  await maybeSnapshotVersion(DOC_ID, "v1", 1_000 + 35 * 1000);

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await expect.element(screen.getByText(/2 edits/)).toBeVisible();

  await screen.getByText(/2 edits/).click();
  expect((await screen.getByText(/1970/).all()).length).toBe(2);

  await screen.getByText(/2 edits/).click();
  expect((await screen.getByText(/1970/).all()).length).toBe(0);
});

test("a session with only one snapshot renders as a plain row, not a group", async () => {
  await maybeSnapshotVersion(DOC_ID, "v0", 1_000);

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  // Wait for the async loadVersions() (triggered by the $effect above) to
  // finish rendering before checking counts — .all() itself doesn't poll.
  await expect.element(screen.getByText(/1970/)).toBeVisible();
  expect(await screen.getByText(/edits/).all()).toHaveLength(0);
  expect((await screen.getByText(/1970/).all()).length).toBe(1);
});
