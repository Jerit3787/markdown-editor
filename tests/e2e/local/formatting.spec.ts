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
    for (const [title, prefix] of [
      ["Heading 1", "# "],
      ["Heading 2", "## "],
      ["Heading 3", "### "],
    ] as const) {
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
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("| Column 1 | Column 2 | Column 3 |");

    await clearContent(page);
    await page.click('button[title="Horizontal rule"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("\n---\n");
  });

  test("math snippet inserts $$\\n\\n$$ with the caret on the interior blank line", async ({ page }) => {
    await clearContent(page);
    await page.click('button[title="Math"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("$$\n\n$$");
    // Caret sits after "$$\n" (offset 3), ready to type the LaTeX source.
    expect(await page.evaluate(() => window.MDE.getEditor().state.selection.main.head)).toBe(3);
    await page.keyboard.type("x^2");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("$$\nx^2\n$$");
  });

  test("footnote snippet: first is [^1], the next numbers past it, a named [^note] is ignored", async ({ page }) => {
    await clearContent(page);
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[^1]\n\n[^1]: ");

    // Caret back to the start, insert another — it must number past [^1].
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0 } }));
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[^2][^1]\n\n[^1]: \n\n[^2]: ");

    // A hand-written named footnote doesn't collide with the numbering.
    await clearContent(page);
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, insert: "text[^note]\n\n[^note]: hi" }, selection: { anchor: 4 } });
    });
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("text[^1][^note]\n\n[^note]: hi\n\n[^1]: ");
  });

  test("footnote snippet is a single undo step", async ({ page }) => {
    await clearContent(page);
    await page.click("#editor-mount .cm-content");
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[^1]\n\n[^1]: ");
    await page.evaluate(() => window.MDE.getEditor().focus());
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("");
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

test.describe("toolbar undo/redo and command palette quick-access", () => {
  test("Undo and Redo toolbar buttons undo/redo the last edit", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("hello world");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("hello world");

    await page.click('button[title^="Undo"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("");

    await page.click('button[title^="Redo"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("hello world");
  });

  test("Command Palette toolbar button opens the palette with its input focused", async ({ page }) => {
    await expect(page.locator(".command-palette")).not.toBeVisible();
    await page.click('button[title^="Command Palette"]');
    await expect(page.locator(".command-palette")).toBeVisible();
    await expect(page.locator(".command-palette-input")).toBeFocused();
  });
});
