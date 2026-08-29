import { test, expect } from "./support/fixtures";

test("a still-open session with several edits renders as one collapsible row", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.evaluate(async () => {
    const { maybeSnapshotVersion } = await import("/src/history.ts");
    const { getActiveDoc } = await import("/src/stores/docs.ts");
    const doc = getActiveDoc();
    if (!doc) throw new Error("no active doc");
    await maybeSnapshotVersion(doc.id, "v0", 1_000);
    await maybeSnapshotVersion(doc.id, "v1", 1_000 + 35_000);
    await maybeSnapshotVersion(doc.id, "v2", 1_000 + 70_000);
  });

  await page.click("#versionHistoryBtn");
  await expect(page.locator(".version-history-row-label", { hasText: "3 edits" })).toBeVisible();
});

test("a real gap prunes the closed session down to its final snapshot", async ({ page }) => {
  // Once "v3" lands 31 minutes after "v2", the write path detects the
  // "v0, v1, v2" session has closed and collapses it to just "v2" before
  // appending "v3" — a closed session is never shown with its full detail
  // again, only the still-open (most recent) one ever is. This test
  // asserts that pruning actually happened: exactly 2 rows exist and
  // neither is a multi-edit session anymore.
  await page.click("#editor-mount .cm-content");
  await page.evaluate(async () => {
    const { maybeSnapshotVersion } = await import("/src/history.ts");
    const { getActiveDoc } = await import("/src/stores/docs.ts");
    const doc = getActiveDoc();
    if (!doc) throw new Error("no active doc");
    await maybeSnapshotVersion(doc.id, "v0", 1_000);
    await maybeSnapshotVersion(doc.id, "v1", 1_000 + 35_000);
    await maybeSnapshotVersion(doc.id, "v2", 1_000 + 70_000);
    await maybeSnapshotVersion(doc.id, "v3", 1_000 + 70_000 + 31 * 60 * 1000);
  });

  await page.click("#versionHistoryBtn");
  await expect(page.locator(".version-history-row")).toHaveCount(2);
  await expect(page.locator(".version-history-row-label", { hasText: "edits" })).toHaveCount(0);
});

test("expanding a session and diffing two of its entries against each other works", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.evaluate(async () => {
    const { maybeSnapshotVersion } = await import("/src/history.ts");
    const { getActiveDoc } = await import("/src/stores/docs.ts");
    const doc = getActiveDoc();
    if (!doc) throw new Error("no active doc");
    await maybeSnapshotVersion(doc.id, "alpha", 1_000);
    await maybeSnapshotVersion(doc.id, "beta", 1_000 + 35_000);
  });

  await page.click("#versionHistoryBtn");
  await page.click(".version-history-row-label:has-text('edits')");
  await page.click('button:has-text("Diff")');
  await page.selectOption("#versionCompareSelect", { index: 1 });
  await expect(page.locator(".diff-view")).toBeVisible();
});
