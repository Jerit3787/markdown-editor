import { test, expect } from "./support/fixtures";

test("a citation with a typed definition renders as a numbered link with a bibliography", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("A claim.[@Smith2020]\n\n[@Smith2020]: Smith, J. (2020). Title. Publisher.");
  await expect(page.locator("#preview .citation-bibliography")).toBeVisible();
  await expect(page.locator("#preview sup a")).toHaveText("1");
  await expect(page.locator("#preview .citation-bibliography li")).toContainText("Smith, J. (2020). Title. Publisher.");
});

test("adding a structured bibliography entry in Document Info round-trips through .md export", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("A claim.[@Smith2020]");

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();
  await page.click('button:has-text("Structured")');
  await page.click('button:has-text("Add entry")');
  await page.fill('.doc-info-citation-row input[placeholder="Key"]', "Smith2020");
  await page.fill('.doc-info-citation-row input[placeholder="Author"]', "Smith, J.");
  await page.fill('.doc-info-citation-row input[placeholder="Year"]', "2020");
  await page.fill('.doc-info-citation-row input[placeholder="Text"]', "Title. Publisher.");

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => window.MDE.exportAs("md"));
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("fs");
  const content = fs.readFileSync(path!, "utf-8");
  expect(content).toBe("A claim.[@Smith2020]\n\n[@Smith2020]: Title. Publisher.\n");
});
