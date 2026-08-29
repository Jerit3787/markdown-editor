import { test, expect } from "./support/fixtures";

test("a citation with a typed definition renders as a numbered link with a bibliography", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("A claim.[@Smith2020]\n\n[@Smith2020]: Smith, J. (2020). Title. Publisher.");
  await expect(page.locator("#preview .citation-bibliography")).toBeVisible();
  await expect(page.locator("#preview sup a")).toHaveText("1");
  await expect(page.locator("#preview .citation-bibliography li")).toContainText("Smith, J. (2020). Title. Publisher.");
});
