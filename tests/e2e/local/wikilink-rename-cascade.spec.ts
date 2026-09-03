import { test, expect } from "./support/fixtures";

test.describe("wikilink rename cascade", () => {
  test("renaming a document updates a [[Name]] reference in another document, with a toast", async ({ page }) => {
    await page.evaluate(async () => {
      const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
      createDoc({ id: "e2e-linker", name: "Linker", content: "See [[E2E Test Doc]] for more" });
      switchDoc("e2e-doc-1");
    });
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });

    await page.click("#docTitle");
    await page.fill("#docTitle", "Renamed Doc");
    await page.keyboard.press("Enter");

    await expect(page.locator(".toast-message")).toHaveText('Updated 1 link to "Renamed Doc"');

    await page.evaluate(async () => {
      const { switchDoc } = await import("/src/stores/docs.ts");
      switchDoc("e2e-linker");
    });
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("See [[Renamed Doc]] for more");
  });

  test("a rename that collides opens RenameCollisionModal, and Replace still cascades", async ({ page }) => {
    await page.evaluate(async () => {
      const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
      createDoc({ id: "e2e-target", name: "Target" });
      createDoc({ id: "e2e-linker2", name: "Linker2", content: "See [[E2E Test Doc]] for more" });
      switchDoc("e2e-doc-1");
    });
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });

    await page.click("#docTitle");
    await page.fill("#docTitle", "Target");
    await page.keyboard.press("Enter");

    await expect(page.locator("text=Name already in use")).toBeVisible();
    await page.click('button:text-is("Replace")');

    await expect(page.locator(".toast-message")).toHaveText('Updated 1 link to "Target"');

    await page.evaluate(async () => {
      const { switchDoc } = await import("/src/stores/docs.ts");
      switchDoc("e2e-linker2");
    });
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("See [[Target]] for more");
  });

  test("a self-referencing document's own open buffer updates on rename", async ({ page }) => {
    await page.evaluate(async () => {
      const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
      createDoc({ id: "e2e-self", name: "SelfRef", content: "This document is called [[SelfRef]]." });
      switchDoc("e2e-self");
    });
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });

    await page.click("#docTitle");
    await page.fill("#docTitle", "SelfRef Renamed");
    await page.keyboard.press("Enter");

    await expect(page.locator(".toast-message")).toHaveText('Updated 1 link to "SelfRef Renamed"');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("This document is called [[SelfRef Renamed]].");
  });
});
