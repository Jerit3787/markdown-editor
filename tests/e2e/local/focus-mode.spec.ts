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

test("SHELL-13: Focus Mode does not persist across a reload", async ({ page }) => {
  await page.click("#viewMenuBtn");
  await page.click('text="Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);

  await page.reload();
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await expect(page.locator("body")).not.toHaveClass(/focus-mode/);
});

test("B1: the desktop focus hint shows on entry and on a top-of-screen mouse move, and exits on click", async ({ page }) => {
  await page.click("#viewMenuBtn");
  await page.click('text="Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);

  // Flashed on entry.
  await expect(page.locator("#focusHint")).toHaveClass(/is-visible/);
  // Auto-hides after the idle timeout.
  await expect(page.locator("#focusHint")).not.toHaveClass(/is-visible/, { timeout: 4000 });

  // A move to the top edge brings it back.
  await page.mouse.move(400, 4);
  await expect(page.locator("#focusHint")).toHaveClass(/is-visible/);

  // Clicking it exits focus mode.
  await page.click("#focusHint");
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
