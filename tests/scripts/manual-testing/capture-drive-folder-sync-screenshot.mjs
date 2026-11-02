// One-off: What's New screenshot for Google Drive folder sync
// (client/public/whats-new/drive-folder-sync.png) — the "open a synced
// folder" picker over a workspace that is already linked. Run against the
// client-only dev server:
//
//   npm run dev:client -- --port 5199 --strictPort &
//   node tests/scripts/manual-testing/capture-drive-folder-sync-screenshot.mjs
//   kill %1
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.MDE_CAPTURE_BASE || "http://localhost:5199";
const OUT = "client/public/whats-new/drive-folder-sync.png";
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
        driveRev: "r1",
      },
    ]),
  );
  localStorage.setItem("mde:active", "d1");
});

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
await page.route("**/api/drive/folders", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      folders: [
        { folderId: "folder-1", folderName: "Launch plan", workspaceId: "w-drive", modifiedTime: new Date().toISOString() },
        { folderId: "folder-2", folderName: "Product notes", workspaceId: "w-other", modifiedTime: new Date(Date.now() - 86_400_000).toISOString() },
      ],
    }),
  }),
);

await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 30000 });

// The release bump auto-opens What's New (and this entry's screenshot is
// the file being captured). Dismiss it before showing the real modal.
await page.waitForTimeout(800);
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 3000 }).catch(() => false)) await gotIt.click();
await page.waitForTimeout(300);

await page.evaluate(() => window.MDE.openDriveFolderPicker?.());
await page.locator("#openDriveModalTitle").waitFor({ state: "visible", timeout: 5000 });
await page.getByText("Product notes").waitFor({ state: "visible", timeout: 5000 });
// Let the modal/sidebar layout settle before the capture.
await page.waitForTimeout(700);

await page.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
