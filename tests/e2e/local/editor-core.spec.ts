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

test.describe("line-prefix commands toggle", () => {
  test("Heading 1 on a line that already starts with '# ' removes the prefix", async ({ page }) => {
    await setDoc(page, "# hello");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: v.state.doc.length } });
    });
    await page.click('button[title="Heading 1"]');
    await expect.poll(() => doc(page)).toBe("hello");
  });

  test("Bullet list toggles the '- ' prefix off and back on", async ({ page }) => {
    await setDoc(page, "item");
    await page.click('button[title="Bullet list"]');
    await expect.poll(() => doc(page)).toBe("- item");
    await page.click('button[title="Bullet list"]');
    await expect.poll(() => doc(page)).toBe("item");
  });

  test("Blockquote toggle off only strips the exact '> ' prefix", async ({ page }) => {
    await setDoc(page, "> quoted");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: 3 } });
    });
    await page.click('button[title="Blockquote"]');
    await expect.poll(() => doc(page)).toBe("quoted");
  });
});

test.describe("Tab indentation", () => {
  test("Tab indents the selected lines and keeps focus in the editor", async ({ page }) => {
    await setDoc(page, "line one\nline two");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    });
    await page.keyboard.press("Tab");
    const after = await doc(page);
    // Each line gained one indent unit at its start; the two lines match.
    expect(after.split("\n").every((l) => /^(\t|\s{2,})line/.test(l))).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") != null)).toBe(true);
  });

  test("Shift-Tab dedents an indented line", async ({ page }) => {
    await setDoc(page, "x");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0, head: 1 } }));
    await page.keyboard.press("Tab");
    expect(await doc(page)).toMatch(/^(\t|\s{2,})x$/);

    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    });
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => doc(page)).toBe("x");
  });
});

test.describe("status bar", () => {
  test("word and character counts update as the document changes", async ({ page }) => {
    await setDoc(page, "");
    await expect(page.locator("#charCount")).toHaveText("0 characters");
    await expect(page.locator("#wordCount")).toHaveText("0 words");

    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("hello world");
    await expect(page.locator("#wordCount")).toHaveText("2 words");
    await expect(page.locator("#charCount")).toHaveText("11 characters");

    // Singular form for exactly one.
    await setDoc(page, "x");
    await page.keyboard.type(" "); // nudge a docChanged so updateCounts runs
    await page.keyboard.press("Backspace");
    await expect(page.locator("#charCount")).toHaveText("1 character");
    await expect(page.locator("#wordCount")).toHaveText("1 word");
  });

  test("cursor position reflects the caret's line and column", async ({ page }) => {
    await setDoc(page, "abc\ndefgh");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0 } }));
    await expect(page.locator("#cursorPos")).toHaveText("Ln 1, Col 1");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 6 } })); // 2 chars into line 2
    await expect(page.locator("#cursorPos")).toHaveText("Ln 2, Col 3");
  });
});
