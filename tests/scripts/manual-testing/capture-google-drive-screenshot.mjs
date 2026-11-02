// One-off: captures the What's New screenshot for the Google Drive import
// feature (client/public/whats-new/google-drive.png) — the File > Open
// submenu with "Markdown from Google Drive..." visible in a real app
// session.
//
// Not part of the test suite. Run against the client-only Vite dev server:
//
//   npm run dev:client -- --port 5199 --strictPort &
//   node tests/scripts/manual-testing/capture-google-drive-screenshot.mjs
//   kill %1
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.MDE_CAPTURE_BASE || "http://localhost:5199";
const OUT = "client/public/whats-new/google-drive.png";
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";

const browser = await chromium.launch(existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 30000 });

// Dismiss the What's New modal if it auto-opened for this version.
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 3000 }).catch(() => false)) await gotIt.click();

// Give the shot a real workspace + document so the editor chrome looks
// representative (the Drive item needs no workspace, but the menu does).
const newWs = page.locator("#emptyNewWorkspaceBtn");
if (await newWs.isVisible({ timeout: 3000 }).catch(() => false)) {
  await newWs.click();
  await page.waitForTimeout(300);
}
await page.evaluate(() => window.MDE.newDoc());
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await page.click("#editor-mount .cm-content");
await page.keyboard.type("# Launch plan\n\nImport the draft from Drive, then share it with the team.");
await page.keyboard.press("Escape").catch(() => {});

// File > Open > Markdown from Google Drive...
await page.click("#fileMenuBtn");
const openSubmenu = page.locator("#fileMenu .menu-submenu", { has: page.locator("#menuOpenDrive") }).first();
await openSubmenu.locator(".menu-submenu-trigger").hover();
await page.locator("#menuOpenDrive").waitFor({ state: "visible", timeout: 5000 });
await page.locator("#menuOpenDrive").hover();
await page.waitForTimeout(400);

await page.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
