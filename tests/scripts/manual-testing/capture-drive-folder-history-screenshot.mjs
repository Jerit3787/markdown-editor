// One-off: What's New screenshot for folder-backed local history
// (client/public/whats-new/drive-folder-history.png) — Version History
// showing a local snapshot merged with Drive revisions. Run against the
// client-only dev server:
//
//   npm run dev:client -- --port 5199 --strictPort &
//   node tests/scripts/manual-testing/capture-drive-folder-history-screenshot.mjs
//   kill %1
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.MDE_CAPTURE_BASE || "http://localhost:5199";
const OUT = "client/public/whats-new/drive-folder-history.png";
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";

const browser = await chromium.launch(existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.addInitScript(() => {
  const now = Date.now();
  localStorage.setItem(
    "mde:workspaces",
    JSON.stringify([
      {
        id: "w-drive",
        name: "Launch plan",
        createdAt: now,
        updatedAt: now,
        driveLink: { folderId: "folder-1", folderName: "Launch plan" },
        driveLastSyncedAt: now,
      },
    ]),
  );
  localStorage.setItem("mde:activeWorkspace", "w-drive");
  localStorage.setItem(
    "mde:docs",
    JSON.stringify([
      {
        id: "d1",
        name: "Launch plan",
        content: "# Launch plan\n\nKeep the draft in Drive, then share it with the team.",
        updatedAt: now,
        createdAt: now,
        workspaceId: "w-drive",
        driveFileId: "file-1",
        drivePath: "Launch plan.md",
        driveRev: "rev-3",
      },
    ]),
  );
  localStorage.setItem("mde:active", "d1");
  localStorage.setItem("mde:whatsNewSeen", "1.69.0");
});

const revisionContent = (text) => Buffer.from(text, "utf-8").toString("base64");

await page.route("**/api/auth/google/status", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, configured: true }) }),
);
await page.route("**/api/auth/github/me", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ connected: true, username: "shot-user", scopes: ["gist", "repo"] }),
  }),
);
await page.route("**/api/drive/file/file-1/revisions", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      revisions: [
        { revId: "rev-3", modifiedTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), author: "Danish" },
        { revId: "rev-2", modifiedTime: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(), author: "Danish" },
      ],
    }),
  }),
);
await page.route("**/api/drive/file/file-1/revisions/rev-3", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      contentBase64: revisionContent("# Launch plan\n\nAn earlier draft with the pricing notes.\n\n- Keep the draft in Drive\n- Share it with the team"),
    }),
  }),
);
await page.route("**/api/drive/file/file-1/revisions/rev-2", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ contentBase64: revisionContent("# Launch plan\n\nInitial outline.") }),
  }),
);

await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 30000 });

const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 3000 }).catch(() => false)) await gotIt.click();

// Seed a local snapshot through the app's own history module, so the
// panel shows the merged local + Drive timeline this feature is about.
await page.evaluate(async () => {
  const { maybeSnapshotVersion } = await import("/src/history.ts");
  await maybeSnapshotVersion("d1", "# Launch plan\n\nA local snapshot from this laptop.", Date.now() - 30 * 60 * 1000);
});

await page.click("#versionHistoryBtn");
await page.locator("#versionHistoryTitle").waitFor({ state: "visible", timeout: 5000 });
await page.getByText("A local snapshot from this laptop.").waitFor({ state: "visible", timeout: 5000 });
await page
  .getByRole("button", { name: /Google Drive revision/ })
  .first()
  .waitFor({ state: "visible", timeout: 5000 });
await page.waitForTimeout(700);

await page.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
