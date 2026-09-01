import { test, expect } from "./support/fixtures";

// #menuBar's dropdowns default to left-anchoring (extending rightward from
// their own trigger) — correct for File/Edit/Format/Insert near the left
// edge of the bar, but a menu close enough to the right edge (Help always;
// View too, once its own dropdown grew past mid-2026) needs its own width
// measured against the viewport at open-time and, when it would overflow,
// flipped to right-anchor instead (see app.ts's toggleDropdown). Previously
// this was a hardcoded `:not(#helpMenu)` CSS carve-out that only covered
// whichever menu happened to be rightmost at the time — View started
// overflowing on a narrow screen without ever being added to that list,
// which is exactly the failure mode a runtime measurement avoids.
test.use({ viewport: { width: 390, height: 844 } });

test("the Help menu dropdown stays within the viewport on a narrow screen", async ({ page }) => {
  await page.click("#helpMenuBtn");
  const helpMenu = page.locator("#helpMenu");
  await expect(helpMenu).toBeVisible();
  const box = (await helpMenu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("the View menu dropdown stays within the viewport on a narrow screen", async ({ page }) => {
  await page.click("#viewMenuBtn");
  const viewMenu = page.locator("#viewMenu");
  await expect(viewMenu).toBeVisible();
  const box = (await viewMenu.boundingBox())!;
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
