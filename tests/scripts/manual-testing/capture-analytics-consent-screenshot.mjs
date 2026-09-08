// One-off: capture client/public/whats-new/analytics-consent.png — the
// consent banner. The banner only renders with a GA id set, so build with
// VITE_GA_MEASUREMENT_ID=G-TEST first:
//   VITE_GA_MEASUREMENT_ID=G-TEST npm run build
//   npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-analytics-consent-screenshot.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/analytics-consent.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
await page.locator(".consent-banner").waitFor({ timeout: 5000 });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
