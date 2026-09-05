import { test, expect } from "./support/fixtures";

test("a definition list renders as a real <dl> in the preview", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("Apple\n:   A fruit");
  await expect(page.locator("#preview dt")).toHaveText("Apple");
  await expect(page.locator("#preview dd")).toHaveText("A fruit");
});

test("superscript and subscript render in the preview", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("2^10^ and H~2~O");
  await expect(page.locator("#preview sup")).toHaveText("10");
  await expect(page.locator("#preview sub")).toHaveText("2");
});

test("strikethrough and footnote references still render correctly alongside the new syntax", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("~~gone~~ and a claim.[^1]\n\n[^1]: A note.");
  await expect(page.locator("#preview del")).toHaveText("gone");
  await expect(page.locator("#preview sup a")).toBeVisible(); // footnote ref renders as a linked <sup>, not this feature's <sup>
});

test("adding a metadata field in Document Info round-trips through .md export", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("# Real content");

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();
  await page.click('button:has-text("Add field")');
  await page.fill('.doc-info-metadata-row input[placeholder="Key"]', "Title");
  await page.fill('.doc-info-metadata-row input[placeholder="Value"]', "Round Trip Test");

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => window.MDE.exportAs("md"));
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("fs");
  const content = fs.readFileSync(path!, "utf-8");
  expect(content).toBe("<!--\nTitle: Round Trip Test\n-->\n\n# Real content");
});
