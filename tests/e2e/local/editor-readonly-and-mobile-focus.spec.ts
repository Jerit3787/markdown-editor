import { test, expect } from "./support/fixtures";

test("EDIT-25: window.MDE.setReadOnly(true) blocks typing; setReadOnly(false) restores it", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("before");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("before");

  await page.evaluate(() => window.MDE.setReadOnly!(true));
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.readOnly)).toBe(true);

  await page.keyboard.press("End");
  await page.keyboard.type(" NOPE");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("before");

  await page.evaluate(() => window.MDE.setReadOnly!(false));
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.readOnly)).toBe(false);
  await page.keyboard.press("End");
  await page.keyboard.type(" again");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("before again");
});

test("MOB-13: the mobile floating 'exit Focus Mode' button appears in focus mode and exits it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const exitBtn = page.locator("#focusModeExitBtn");
  await expect(exitBtn).toBeHidden(); // not in focus mode yet

  await page.click("#viewMenuBtn");
  await page.click('text="Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);
  await expect(exitBtn).toBeVisible();

  // its box stays within the viewport's right edge
  const box = (await exitBtn.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  await exitBtn.click();
  await expect(page.locator("body")).not.toHaveClass(/focus-mode/);
  await expect(exitBtn).toBeHidden();
});

test("MOB-13: on a desktop viewport the exit-Focus button stays hidden even in focus mode", async ({ page }) => {
  await page.click("#viewMenuBtn");
  await page.click('text="Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);
  await expect(page.locator("#focusModeExitBtn")).toBeHidden(); // desktop uses the topbar toggle / Escape
});
