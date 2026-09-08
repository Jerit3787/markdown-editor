// One-off: capture client/public/whats-new/topbar-chrome-v2.png — the
// signed-in account menu open, showing the header + Settings + Sign out.
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/topbar-chrome-v2.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 520 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.route("**/api/auth/github/me", (r) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ connected: true, username: "octocat" }),
  }),
);
await page.goto(`${BASE}/api/dev/login?username=octocat`);
await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
await page.click("#emptyNewWorkspaceBtn").catch(() => {});
await page.keyboard.press("Escape").catch(() => {});
await page.evaluate(() => window.MDE.newDoc());
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await page.locator("#topbar-account-mount .topbar-account-btn").click();
await page.locator('.topbar-account-menu [role="menuitem"]:has-text("Sign out")').waitFor({ timeout: 3000 });
// Let both avatar images (button ?size=80, header ?size=64) settle.
await page
  .locator(".topbar-account-header-avatar img")
  .evaluate((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r))))
  .catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1100, height: 360 } });
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
