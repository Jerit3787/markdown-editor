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

test("MDX-15: structured metadata set in Document Info is not shown as content in the preview", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("# Body heading\n\nBody text.");

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();
  await page.click('button:has-text("Add field")');
  await page.fill('.doc-info-metadata-row input[placeholder="Key"]', "Title");
  await page.fill('.doc-info-metadata-row input[placeholder="Value"]', "Secret Title");
  await page.locator(".modal-box-v2", { hasText: "Edit document" }).getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("Escape").catch(() => {});

  await expect(page.locator("#preview h1")).toHaveText("Body heading");
  await expect(page.locator("#preview")).not.toContainText("Secret Title");
  await expect(page.locator("#preview")).not.toContainText("Title: Secret Title");
});

test("MDX-22: definition lists, superscript and subscript survive a .md export round-trip", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("Term\n:   Definition\n\nH~2~O and E=mc^2^");

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => window.MDE.exportAs("md"));
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("fs");
  const exported = fs.readFileSync(path!, "utf-8");

  // The MultiMarkdown source markers round-trip — not rendered <dl>/<sup>/<sub>.
  expect(exported).toContain(":   Definition");
  expect(exported).toContain("H~2~O");
  expect(exported).toContain("mc^2^");
  expect(exported).not.toContain("<dl>");
  expect(exported).not.toContain("<sup>");
});
