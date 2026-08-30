import { test, expect } from "./support/fixtures";

// iOS Safari auto-zooms the whole page in when a focused input's computed
// font-size is under 16px (see the !important rule in _variables.scss).
// Styled text fields set their own smaller font-size on a class selector,
// which used to silently outrank that mobile floor by CSS specificity —
// this pins the fix down on two representative fields: one pre-existing
// (LinkModal) and one from DocEditModal.
test.use({ viewport: { width: 375, height: 700 } });

test("styled text fields stay at 16px on a narrow (mobile) viewport", async ({ page }) => {
  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();
  const nameFontSize = await page.locator("#docEditNameInput").evaluate((el) => getComputedStyle(el).fontSize);
  expect(nameFontSize).toBe("16px");

  await page.locator(".modal-box-v2", { hasText: "Edit document" }).getByRole("button", { name: "Close" }).click();
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Close" }).click();

  await page.click("#editor-mount .cm-content");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".modal-box-v2", { state: "visible" });
  const linkFontSize = await page.locator('input[placeholder="Link text"]').evaluate((el) => getComputedStyle(el).fontSize);
  expect(linkFontSize).toBe("16px");
});
