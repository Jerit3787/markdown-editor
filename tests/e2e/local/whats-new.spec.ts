import { test, expect } from "./support/fixtures";

test("Help menu > What's New shows a category index; picking one steps through it, Done returns to the index", async ({ page }) => {
  await page.click("#helpMenuBtn");
  await page.click('button:has-text("What\'s New")');

  const categoryRow = (name: string) => page.locator(".whats-new-category-row", { hasText: name });
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
