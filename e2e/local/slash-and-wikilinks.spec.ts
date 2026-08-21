import { test, expect } from "./support/fixtures";

test.describe("slash commands", () => {
  test("typing / opens the menu, filters, and runs a command", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("/head");
    await expect(page.locator('text="Heading 1"')).toBeVisible();
    await page.click('text="Heading 1"');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("# ");
  });

  test("Escape closes the slash menu without inserting", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("/tab");
    await expect(page.locator('text="Table"')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('text="Table"')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("/tab");
  });
});

test.describe("wikilink autocomplete", () => {
  test.beforeEach(async ({ page }) => {
    // A second document to link to, created through the store's own API
    // (not a raw localStorage write) — the wikilink menu and preview's
    // link-rendering both resolve against the in-memory docsStore
    // (get(docsStore)), which a raw write never reaches; confirmed live,
    // the target simply never appeared in the menu without this.
    // createDoc() always switches to the doc it creates, so switch back
    // to doc1 afterward to keep typing there.
    await page.evaluate(async () => {
      const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
      createDoc({ id: "e2e-doc-2", name: "Other Doc" });
      switchDoc("e2e-doc-1");
    });
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  });

  test("typing [[ opens the menu and filters by existing doc names", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("[[Oth");
    await expect(page.locator('.slash-menu :text("Other Doc")')).toBeVisible();
  });

  test("Escape closes the wikilink menu without inserting ]]", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("[[Oth");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[[Oth");
  });

  test("clicking an existing wikilink in the preview navigates to it", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("[[Other Doc]]");
    await page.waitForTimeout(50); // let the wikilink autocomplete menu close on its own via the trailing "]]"
    await page.click("#preview .wikilink");
    await expect(page).toHaveURL(/\/d\/e2e-doc-2/);
  });

  test("clicking a non-existent wikilink creates a new document", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("[[Brand New Doc]]");
    await page.waitForTimeout(50);
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length);
    await page.click("#preview .wikilink-missing");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length)).toBe(before + 1);
  });
});
