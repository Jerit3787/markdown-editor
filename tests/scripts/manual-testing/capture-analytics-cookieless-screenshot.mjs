// One-off: capture client/public/whats-new/analytics-cookieless.png — the
// reworded consent banner (v1.60.0). The banner only renders with a GA id
// set, so build with one first:
//   VITE_GA_MEASUREMENT_ID=G-TEST npm run build
//   npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-analytics-cookieless-screenshot.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/analytics-cookieless.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
const banner = page.locator(".consent-banner");
await banner.waitFor({ timeout: 5000 });
await page.waitForTimeout(300);
const box = await banner.boundingBox();
await page.screenshot({
  path: OUT,
  clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: Math.min(1200, box.width + 32), height: box.height + 32 },
});
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
