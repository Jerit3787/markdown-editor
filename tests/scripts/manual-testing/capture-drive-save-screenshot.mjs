// One-off: What's New screenshot for "Save to Google Drive"
// (client/public/whats-new/drive-save.png) — the File > Publish submenu
// with the new Drive row. Run against the client-only dev server:
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

// No Worker in dev; mock the status probes so both the GitHub and Drive
// rows of the Publish submenu render.
await page.route("**/api/auth/google/status", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: false, configured: true }) }),
);
await page.route("**/api/auth/github/me", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username: "shot-user", scopes: ["gist", "repo"] }) }),
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
await page.click("#editor-mount .cm-content");
await page.keyboard.type("# Launch plan\n\nKeep the draft in Drive, then share it with the team.");

await page.click("#fileMenuBtn");
const publishSubmenu = page.locator("#fileMenu .menu-submenu", { has: page.locator("#menuSaveDrive") }).first();
await publishSubmenu.locator(".menu-submenu-trigger").hover();
await page.locator("#menuSaveDrive").waitFor({ state: "visible", timeout: 5000 });
await page.locator("#menuSaveDrive").hover();
await page.waitForTimeout(400);

await page.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
