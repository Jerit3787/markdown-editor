import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function setDoc(page: Page, content: string) {
  await page.evaluate((content) => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: content.length } });
    view.focus();
  }, content);
}
const doc = (page: Page) => page.evaluate(() => window.MDE.getEditor().state.doc.toString());
const sel = (page: Page) =>
  page.evaluate(() => {
    const s = window.MDE.getEditor().state.selection.main;
    return { from: s.from, to: s.to, text: window.MDE.getEditor().state.sliceDoc(s.from, s.to) };
  });

test.describe("wrap commands with no selection", () => {
  test("bold on an empty selection inserts the placeholder and selects just the placeholder text", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Bold"]');
    await expect.poll(() => doc(page)).toBe("**bold text**");
    // The placeholder itself is selected, so typing replaces it.
    expect(await sel(page)).toEqual({ from: 2, to: 11, text: "bold text" });
    await page.keyboard.type("hi");
    await expect.poll(() => doc(page)).toBe("**hi**");
  });

  test("italic and inline code place-and-select their own placeholders", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Italic"]');
    await expect.poll(() => doc(page)).toBe("_italic text_");
    expect((await sel(page)).text).toBe("italic text");

    await setDoc(page, "");
    await page.click('button[title="Inline code"]');
    await expect.poll(() => doc(page)).toBe("`code`");
    expect((await sel(page)).text).toBe("code");
  });
});
