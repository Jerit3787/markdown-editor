import { test, expect } from "./support/fixtures";

test("MenuBar's View menu toggles Focus Mode", async ({ page }) => {
  await page.click("#viewMenuBtn");
  await page.click('text="Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);
});

test("Command Palette toggles Focus Mode", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.fill('input[placeholder*="Search" i]', "Focus Mode");
  await page.click('text="Turn on Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);
});

test("Escape exits Focus Mode", async ({ page }) => {
  await page.click("#viewMenuBtn");
  await page.click('text="Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);
  await page.click("#editor-mount .cm-content");
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/focus-mode/);
});

test("undo and redo round-trip an edit", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("hello");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("hello");
  await page.evaluate(() => window.MDE.undo());
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("");
  await page.evaluate(() => window.MDE.redo());
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("hello");
});
