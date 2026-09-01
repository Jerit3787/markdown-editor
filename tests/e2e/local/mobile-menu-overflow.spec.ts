import { test, expect } from "./support/fixtures";

// #menuBar .dropdown-menu blanket-anchors every menu trigger's dropdown to
// its own left edge (extending rightward) — correct for File/Edit/Format/
// Insert/View near the left edge of the bar, but Help is the last/
// rightmost item, so the same left-anchor pushed its dropdown off the
// right edge of the viewport on mobile.
test.use({ viewport: { width: 390, height: 844 } });

test("the Help menu dropdown stays within the viewport on a narrow screen", async ({ page }) => {
  await page.click("#helpMenuBtn");
  const helpMenu = page.locator("#helpMenu");
  await expect(helpMenu).toBeVisible();
  const box = (await helpMenu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("the File menu dropdown still anchors to the left, extending rightward", async ({ page }) => {
  await page.click("#fileMenuBtn");
  const fileMenu = page.locator("#fileMenu");
  await expect(fileMenu).toBeVisible();
  const box = (await fileMenu.boundingBox())!;
  const btnBox = (await page.locator("#fileMenuBtn").boundingBox())!;
  expect(Math.abs(box.x - btnBox.x)).toBeLessThan(15); // roughly flush with the trigger's left edge, not right-anchored (which would be off by hundreds of px)
});
