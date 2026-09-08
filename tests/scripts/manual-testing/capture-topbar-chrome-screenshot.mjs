// One-off: capture client/public/whats-new/topbar-chrome.png — the
// signed-in top bar with the avatar + a tooltip visible.
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-topbar-chrome-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/topbar-chrome.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 380 }, deviceScaleFactor: 2 });
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
await page.fill("#docTitle", "Product brief");
await page.click("#editor-mount .cm-content");
await page.keyboard.type("# Product brief\n\nDraft — comments welcome.");
await page.hover("#versionHistoryBtn");
await page.waitForTimeout(400);
// The top bar plus a strip below it, so the hover tooltip (which drops
// below the button) is in frame.
const bar = await page.locator("#topbar").boundingBox();
await page.screenshot({
  path: OUT,
  clip: { x: 0, y: 0, width: bar.width, height: bar.height + 40 },
});
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
