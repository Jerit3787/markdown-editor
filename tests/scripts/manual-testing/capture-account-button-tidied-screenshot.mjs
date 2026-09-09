// One-off: capture client/public/whats-new/account-button-tidied.png —
// the signed-out account button (circle outline) with its menu open,
// showing Sign in with GitHub + Settings.
//   npm run build && npm run dev &   # wait for :8787  (no dev-login needed — signed out is the default)
//   node tests/scripts/manual-testing/capture-account-button-tidied-screenshot.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/account-button-tidied.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 520 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
await page.click("#emptyNewWorkspaceBtn").catch(() => {});
await page.keyboard.press("Escape").catch(() => {});
await page.evaluate(() => window.MDE.newDoc());
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });

const btn = page.locator("#topbar-account-mount .topbar-account-btn");
await btn.click();
await page.locator('.topbar-account-menu [role="menuitem"]:has-text("Sign in with GitHub")').waitFor({ timeout: 3000 });
// Drop focus + move the pointer off the button so the hover/focus
// tooltip chip doesn't overlap the menu in the shot.
await btn.evaluate((el) => el.blur());
await page.mouse.move(550, 300);
await page.waitForTimeout(300);
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1100, height: 380 } });
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
