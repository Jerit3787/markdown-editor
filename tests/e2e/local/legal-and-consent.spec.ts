import { test, expect } from "./support/fixtures";

test("v1.57: About links out to the standalone legal pages", async ({ page }) => {
  await page.click("#helpMenuBtn");
  await page.click("#menuInfo");
  await expect(page.locator('a[href="/terms"][target="_blank"]')).toBeVisible();
  await expect(page.locator('a[href="/privacy"][target="_blank"]')).toBeVisible();
});

test("v1.57: no consent banner in a build without a GA measurement id", async ({ page }) => {
  // The local suite builds/serves the client with VITE_GA_MEASUREMENT_ID unset —
  // ConsentBanner mounts but renders nothing (an empty {#if} placeholder).
  await expect(page.locator("#consent-banner-mount")).toHaveCount(1);
  await expect(page.locator(".consent-banner")).toHaveCount(0);
  expect((await page.locator("#consent-banner-mount").textContent())?.trim()).toBe("");
});
