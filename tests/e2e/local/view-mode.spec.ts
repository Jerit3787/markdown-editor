import { test, expect } from "./support/fixtures";

test("toolbar view-selector buttons toggle panes", async ({ page }) => {
  await expect(page.locator("#body")).toHaveClass(/mode-split/);

  await page.click('.view-selector button[title="Toggle preview pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);

  await page.click('.view-selector button[title="Toggle preview pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-split/);

  await page.click('.view-selector button[title="Toggle editor pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-preview/);
});

test("MenuBar's View menu toggles panes", async ({ page }) => {
  await page.click("#viewMenuBtn");
  await page.click('text="Preview pane"');
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);
});

test("Command Palette switches view mode", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.fill('input[placeholder*="Search" i]', "Editor view");
  await page.click('text="Switch to Editor view"');
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);
});

test("view mode persists across reload", async ({ page }) => {
  await page.click('.view-selector button[title="Toggle preview pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);
  await page.reload();
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);
});
