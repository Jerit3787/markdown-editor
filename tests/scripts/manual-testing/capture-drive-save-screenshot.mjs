// One-off: What's New screenshot for "Save to Google Drive"
// (client/public/whats-new/drive-save.png) — the first-save dialog with
// the filename + destination folder. Run against the client-only dev
// server:
//
//   npm run dev:client -- --port 5199 --strictPort &
//   node tests/scripts/manual-testing/capture-drive-save-screenshot.mjs
//   kill %1
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.MDE_CAPTURE_BASE || "http://localhost:5199";
const OUT = "client/public/whats-new/drive-save.png";
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";

const browser = await chromium.launch(existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// No Worker in dev: pretend Drive is already connected so the save action
// opens its dialog instead of the OAuth popup (nothing is posted until
// the user clicks Save, so this is a purely visual state).
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

await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 30000 });

const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 3000 }).catch(() => false)) await gotIt.click();

const newWs = page.locator("#emptyNewWorkspaceBtn");
if (await newWs.isVisible({ timeout: 3000 }).catch(() => false)) {
  await newWs.click();
  await page.waitForTimeout(300);
}
await page.evaluate(() => window.MDE.newDoc());
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
// Name it up front so the dialog proposes "Launch plan.md" rather than
// "Untitled.md" (the dialog seeds from the doc name when it opens).
await page.evaluate(() => window.MDE.renameActiveDoc("Launch plan"));
await page.click("#editor-mount .cm-content");
await page.keyboard.type("# Launch plan\n\nKeep the draft in Drive, then share it with the team.");

// File > Publish > Save to Google Drive → the first-save dialog.
await page.click("#fileMenuBtn");
const publishSubmenu = page.locator("#fileMenu .menu-submenu", { has: page.locator("#menuSaveDrive") }).first();
await publishSubmenu.locator(".menu-submenu-trigger").hover();
await page.locator("#menuSaveDrive").waitFor({ state: "visible", timeout: 5000 });
await page.locator("#menuSaveDrive").click();
await page.locator("#driveExportName").waitFor({ state: "visible", timeout: 5000 });
// Let the sidebar/panel layout transition finish before capturing.
await page.waitForTimeout(700);

await page.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
