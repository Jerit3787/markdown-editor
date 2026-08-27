import { test, expect } from "./support/fixtures";

test("Ctrl/Cmd+F opens the find bar and highlights matches with a live count", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("the cat sat on the cat mat");
  await page.keyboard.press("ControlOrMeta+F");

  await expect(page.locator(".find-replace-bar")).toBeVisible();
  await page.getByLabel("Find").fill("cat");
  await expect(page.getByText("1 of 2")).toBeVisible();
  await expect(page.locator(".cm-searchMatch")).toHaveCount(2);
});

test("Ctrl/Cmd+H opens with the replace row, and Replace All replaces every match", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("the cat sat on the cat mat");
  await page.keyboard.press("ControlOrMeta+H");

  await expect(page.getByLabel("Replace", { exact: true })).toBeVisible();
  await page.getByLabel("Find").fill("cat");
  await page.getByLabel("Replace", { exact: true }).fill("dog");
  await page.getByRole("button", { name: "Replace All" }).click();

  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("the dog sat on the dog mat");
});

test("Escape closes the find bar", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.press("ControlOrMeta+F");
  await expect(page.locator(".find-replace-bar")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".find-replace-bar")).not.toBeVisible();
});
