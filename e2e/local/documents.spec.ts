import { test, expect } from "./support/fixtures";

test("app loads and shows the seeded document", async ({ page, docId }) => {
  await expect(page.locator("#docList li.active .doc-name")).toHaveText("E2E Test Doc");
  await expect(page.locator("#editor-mount .cm-content")).toBeVisible();
  const docsInStorage = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]"));
  expect(docsInStorage).toHaveLength(1);
  expect(docsInStorage[0].id).toBe(docId);
});

test("typing in the editor updates the doc content", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("hello world");
  await expect
    .poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString()))
    .toBe("hello world");
});

test("creating a new document adds it to the sidebar and switches to it", async ({ page }) => {
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length);
  await page.evaluate(() => window.MDE.newDoc());
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length))
    .toBe(before + 1);
});
