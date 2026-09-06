import { test, expect } from "./support/fixtures";

test("Help menu > What's New shows a category index; picking one steps through it, Done returns to the index", async ({ page }) => {
  await page.click("#helpMenuBtn");
  await page.click('button:has-text("What\'s New")');

  const categoryRow = (name: string) => page.locator(".whats-new-category-card", { hasText: name });
  await expect(categoryRow("Editing & Formatting")).toBeVisible();
  await expect(categoryRow("GitHub Integration")).toBeVisible();

  await categoryRow("GitHub Integration").click();
  await expect(page.locator("text=Choose Gist Visibility")).toBeVisible();
  await expect(page.locator("text=1 of 3")).toBeVisible();

  await page.click('button:has-text("Next →")');
  await page.click('button:has-text("Next →")');
  await expect(page.locator("text=3 of 3")).toBeVisible();
  await page.click('button:has-text("Done")');

  await expect(categoryRow("GitHub Integration")).toBeVisible();
  await expect(page.locator("text=Choose Gist Visibility")).not.toBeVisible();

  await categoryRow("Version History").click();
  await page.click('button:has-text("Categories")');
  await expect(categoryRow("Editing & Formatting")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(categoryRow("Editing & Formatting")).not.toBeVisible();
});

test("SHELL-10: What's New auto-opens once for missed entries, then marks them seen", async ({ page }) => {
  // The fixture seeds mde:whatsNewSeen to a very-high version so nothing
  // is ever "missed" — clear it and reload to hit the auto-open path.
  await page.evaluate(() => localStorage.removeItem("mde:whatsNewSeen"));
  await page.reload();
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });

  // Auto-open: the catch-up popup (not the category index).
  const dismiss = page.locator('button:has-text("Got it"), .modal-box-v2 button:has-text("Done")').first();
  await expect(dismiss).toBeVisible();
  await dismiss.click();

  // Dismissing bumps localStorage to the current build version.
  const seen = await page.evaluate(() => localStorage.getItem("mde:whatsNewSeen"));
  const appVersion = await page.evaluate(() => (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__ ?? "");
  expect(seen).not.toBeNull();
  if (appVersion) expect(seen).toBe(appVersion);

  // A second reload does not re-open it.
  await page.reload();
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await page.waitForTimeout(500);
  await expect(page.locator('button:has-text("Got it")')).toHaveCount(0);
});
