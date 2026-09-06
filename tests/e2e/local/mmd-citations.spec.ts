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

test("MDX-18: Author-year display style renders inline author-year citations in the preview", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("As shown [@Smith2020].");

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  const editModal = page.locator(".modal-box-v2", { hasText: "Edit document" });
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();
  await editModal.getByRole("button", { name: "Structured" }).click();
  await editModal.getByRole("button", { name: "Add entry" }).click();
  await page.fill('.doc-info-citation-row input[placeholder="Key"]', "Smith2020");
  await page.fill('.doc-info-citation-row input[placeholder="Author"]', "Smith");
  await page.fill('.doc-info-citation-row input[placeholder="Year"]', "2020");
  await page.fill('.doc-info-citation-row input[placeholder="Text"]', "A Title.");
  await editModal.getByRole("button", { name: "Author-year" }).click();
  await editModal.getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("Escape").catch(() => {});

  const preview = page.locator("#preview");
  await expect(preview).toContainText("Smith");
  await expect(preview).toContainText("2020");
  // Not the numbered "[1]" form.
  await expect(page.locator("#preview sup a")).toHaveCount(0);
});

test("MDX-19: switching the marker style to MultiMarkdown makes [#key] citations resolve", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("See [#Jones2019].\n\n[#Jones2019]: Jones (2019). Work.");

  // Default marker style is Pandoc — [#key] stays literal.
  await expect(page.locator("#preview")).toContainText("[#Jones2019]");
  await expect(page.locator("#preview .citation-bibliography")).toHaveCount(0);

  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  const editModal = page.locator(".modal-box-v2", { hasText: "Edit document" });
  await page.locator(".modal-box-v2", { hasText: "Document info" }).getByRole("button", { name: "Edit" }).click();
  await editModal.getByRole("button", { name: "MultiMarkdown [#key]" }).click();
  await editModal.getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("Escape").catch(() => {});

  await expect(page.locator("#preview sup a")).toHaveText("1");
  await expect(page.locator("#preview .citation-bibliography li")).toContainText("Jones (2019). Work.");
});
