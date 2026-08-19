import { test, expect } from "./support/fixtures";

test.describe("keybinding modes", () => {
  test.afterEach(async ({ page }) => {
    // Reset to normal so later tests in this file (and file-level
    // parallelism across other spec files sharing the same seeded
    // localStorage key) don't inherit a non-default mode.
    await page.evaluate(async () => {
      const { setKeybindingMode } = await import("/src/stores/keybindings.ts");
      setKeybindingMode("normal");
    });
  });

  test("switching to Vim mode via Settings shows the status indicator and enables vim motions", async ({ page }) => {
    await page.click("#settingsBtn");
    await page.click('button:has-text("Vim")');
    await page.keyboard.press("Escape"); // close Settings
    await page.click("#editor-mount .cm-content");
    const indicator = page.locator("#keybindingMode");
    await expect(indicator).toBeVisible();
    await page.keyboard.press("i"); // vim: enter insert mode
    await expect(indicator).toHaveText("INSERT");
  });

  test("switching to Emacs mode via Settings shows the status indicator", async ({ page }) => {
    await page.click("#settingsBtn");
    await page.click('button:has-text("Emacs")');
    await page.keyboard.press("Escape");
    await expect(page.locator("#keybindingMode")).toHaveText("EMACS");
  });

  test("switching back to Normal hides the status indicator", async ({ page }) => {
    await page.click("#settingsBtn");
    await page.click('button:has-text("Vim")');
    await page.click('button:has-text("Normal")');
    await page.keyboard.press("Escape");
    await expect(page.locator("#keybindingMode")).toBeHidden();
  });
});
