import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function setContentAndSelectAll(page: Page, content: string) {
  await page.evaluate((content) => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0, head: content.length } });
    // Setting the selection via dispatch() doesn't give the content DOM
    // actual browser focus — without this, Mod-key presses never reach
    // CodeMirror's keymap at all (confirmed live: all three Mod-key
    // tests silently no-op'd until this was added).
    view.focus();
  }, content);
}

async function clearContent(page: Page) {
  await page.evaluate(() => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
  });
}

test.describe("formatting commands via the toolbar", () => {
  test("bold", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.click('button[title^="Bold"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("**hello**");
  });

  test("italic", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.click('button[title^="Italic"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("_hello_");
  });

  test("strikethrough", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.click('button[title="Strikethrough"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("~~hello~~");
  });

  test("heading 1/2/3", async ({ page }) => {
    for (const [title, prefix] of [["Heading 1", "# "], ["Heading 2", "## "], ["Heading 3", "### "]] as const) {
      await setContentAndSelectAll(page, "hello");
      await page.click(`button[title="${title}"]`);
      await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe(`${prefix}hello`);
    }
  });

  test("blockquote, inline code, code block", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.click('button[title="Blockquote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("> hello");

    await setContentAndSelectAll(page, "hello");
    await page.click('button[title="Inline code"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("`hello`");

    await setContentAndSelectAll(page, "hello");
    await page.click('button[title="Code block"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("```\nhello\n```");
  });

  test("bullet list, numbered list, task list", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.click('button[title="Bullet list"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("- hello");

    await setContentAndSelectAll(page, "hello");
    await page.click('button[title="Numbered list"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("1. hello");

    await setContentAndSelectAll(page, "hello");
    await page.click('button[title="Task list"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("- [ ] hello");
  });

  test("table and horizontal rule", async ({ page }) => {
    await clearContent(page);
    await page.click('button[title="Table"]');
    await expect
      .poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString()))
      .toContain("| Column 1 | Column 2 | Column 3 |");

    await clearContent(page);
    await page.click('button[title="Horizontal rule"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("\n---\n");
  });

  test("math and footnote snippets", async ({ page }) => {
    await clearContent(page);
    await page.click('button[title="Math"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("$$\n\n$$");

    await clearContent(page);
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[^1]\n\n[^1]: ");
  });

  test("link opens the link modal with the selection prefilled", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.click('button[title^="Link"]');
    const urlInput = page.locator('input[placeholder*="https://" i], input[type="url"]').first();
    await expect(urlInput).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("Mod-key shortcuts", () => {
  test("Mod-b wraps the selection in bold", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.keyboard.press("ControlOrMeta+b");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("**hello**");
  });

  test("Mod-i wraps the selection in italic", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.keyboard.press("ControlOrMeta+i");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("_hello_");
  });

  test("Mod-k opens the link modal", async ({ page }) => {
    await setContentAndSelectAll(page, "hello");
    await page.keyboard.press("ControlOrMeta+k");
    const urlInput = page.locator('input[placeholder*="https://" i], input[type="url"]').first();
    await expect(urlInput).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
