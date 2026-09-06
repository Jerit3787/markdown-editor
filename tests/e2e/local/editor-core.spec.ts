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

test.describe("link modal insertion", () => {
  const insertBtn = (page: Page) => page.locator("#link-modal-mount button.primary-btn");

  test("Insert writes [text](url) at the selection", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Link"]');
    await page.fill('input[placeholder="Link text"]', "Anthropic");
    await page.fill('input[placeholder="https://example.com"]', "https://anthropic.com");
    await insertBtn(page).click();
    await expect.poll(() => doc(page)).toBe("[Anthropic](https://anthropic.com)");
  });

  test("empty fields fall back to 'link text' and 'https://'", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Link"]');
    await insertBtn(page).click();
    await expect.poll(() => doc(page)).toBe("[link text](https://)");
  });

  test("a selected word prefills the Link text field", async ({ page }) => {
    await setDoc(page, "click here");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 6, head: 10 } })); // "here"
    await page.click('button[title^="Link"]');
    await expect(page.locator('input[placeholder="Link text"]')).toHaveValue("here");
    await page.fill('input[placeholder="https://example.com"]', "https://x.com");
    await insertBtn(page).click();
    await expect.poll(() => doc(page)).toBe("click [here](https://x.com)");
  });
});

test.describe("Edit menu clipboard commands", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  // These share one OS clipboard — running them in parallel lets one test's
  // writeText race another's readText. Serialize within this block.
  test.describe.configure({ mode: "serial" });
  const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

  test("Copy puts the selection on the clipboard without changing the document", async ({ page }) => {
    await setDoc(page, "copy me please");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0, head: 7 } })); // "copy me"
    await page.click("#editMenuBtn");
    await page.click("#menuCopy");
    await expect.poll(() => doc(page)).toBe("copy me please");
    expect(await clip(page)).toBe("copy me");
  });

  test("Cut removes the selection and puts it on the clipboard", async ({ page }) => {
    await setDoc(page, "cut this out");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 4, head: 9 } })); // "this "
    await page.click("#editMenuBtn");
    await page.click("#menuCut");
    await expect.poll(() => doc(page)).toBe("cut out");
    expect(await clip(page)).toBe("this ");
  });

  test("Paste inserts the clipboard text at the caret", async ({ page }) => {
    await setDoc(page, "before  after");
    await page.evaluate(() => navigator.clipboard.writeText("MIDDLE"));
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 7 } })); // between the two spaces
    await page.click("#editMenuBtn");
    await page.click("#menuPaste");
    await expect.poll(() => doc(page)).toBe("before MIDDLE after");
  });

  test("Copy with no selection is a no-op", async ({ page }) => {
    await setDoc(page, "untouched");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 3 } }));
    await page.click("#editMenuBtn");
    await page.click("#menuCopy");
    await expect.poll(() => doc(page)).toBe("untouched");
  });
});

test.describe("autosave", () => {
  test("typed content is debounce-saved to localStorage and survives a reload", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("persist this across reload");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
          return docs.find((d: { id: string }) => d.id === "e2e-doc-1")?.content ?? "";
        }),
      )
      .toBe("persist this across reload");

    await page.reload();
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await expect.poll(() => doc(page)).toBe("persist this across reload");
  });
});

test.describe("toolbar overflow (desktop, narrow)", () => {
  test.use({ viewport: { width: 900, height: 800 } });
  const overflowToggle = (page: Page) => page.locator('.toolbar-overflow button[aria-label="More formatting options"]');

  test("buttons that don't fit move into the overflow menu and still run", async ({ page }) => {
    await expect(overflowToggle(page)).toBeVisible();

    await setDoc(page, "");
    await overflowToggle(page).click();
    const menu = page.locator(".toolbar-overflow-menu");
    await expect(menu).toBeVisible();
    // Use whatever the overflow menu actually holds — the last button is
    // the reliable overflow victim (Command Palette is pushed out first).
    const overflowed = menu.locator("button").last();
    const title = await overflowed.getAttribute("title");
    await overflowed.click();
    // Command Palette opens a dialog; a formatting command mutates the doc.
    if (title?.startsWith("Command Palette")) {
      await expect(page.locator(".command-palette")).toBeVisible();
    } else {
      await expect.poll(() => doc(page)).not.toBe("");
    }
  });

  test("widening past the toolbar width hides the overflow toggle again", async ({ page }) => {
    await expect(overflowToggle(page)).toBeVisible();
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect(overflowToggle(page)).toBeHidden();
  });
});
