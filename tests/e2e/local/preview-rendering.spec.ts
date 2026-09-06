import { test, expect } from "./support/fixtures";

test("live rendering: heading, mermaid, math, footnote", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("# Heading\n\n```mermaid\ngraph TD; A-->B;\n```\n\nMath: $x^2$\n\nFootnote[^1]\n\n[^1]: note");
  await expect(page.locator("#preview h1")).toHaveText("Heading");
  await expect(page.locator("#preview svg")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#preview .katex")).toBeVisible();
  await expect(page.locator("#preview sup")).toBeVisible();
});

test("sync-scroll follows the editor in split view, respects the mode-split gate", async ({ page }) => {
  const longContent = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}.\n`).join("\n");
  await page.evaluate((content) => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, longContent);
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    window.MDE.getEditor().scrollDOM.scrollTop = 1500;
    window.MDE.getEditor().scrollDOM.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => page.evaluate(() => document.getElementById("preview")!.scrollTop)).toBeGreaterThan(0);

  await page.click('.view-selector button[title="Toggle preview pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);
  const previewScrollBefore = await page.evaluate(() => document.getElementById("preview")!.scrollTop);
  await page.evaluate(() => {
    window.MDE.getEditor().scrollDOM.scrollTop = 0;
    window.MDE.getEditor().scrollDOM.dispatchEvent(new Event("scroll"));
  });
  const previewScrollAfter = await page.evaluate(() => document.getElementById("preview")!.scrollTop);
  expect(previewScrollAfter).toBe(previewScrollBefore); // unchanged — sync-scroll is gated off outside split view
});

test("cursor-follow scrolls the preview to an off-screen cursor position", async ({ page }) => {
  const longContent = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}.\n`).join("\n");
  await page.evaluate((content) => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, longContent);
  await page.waitForTimeout(200);
  await page.evaluate(() => (document.getElementById("preview")!.scrollTop = 0));
  await page.evaluate(() => {
    const view = window.MDE.getEditor();
    const line = view.state.doc.line(Math.min(150, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from } });
  });
  await expect.poll(() => page.evaluate(() => document.getElementById("preview")!.scrollTop)).toBeGreaterThan(0);
});

test("theme toggle re-renders mermaid diagrams", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("```mermaid\ngraph TD; A-->B;\n```");
  await expect(page.locator("#preview svg")).toBeVisible({ timeout: 5000 });
  // page.evaluate() can't structurally-clone a raw DOM element back to
  // Node — evaluateHandle() keeps it as a live in-page reference instead,
  // which a later evaluate() can compare against by identity.
  const svgBefore = await page.evaluateHandle(() => document.querySelector("#preview svg"));
  await page.click("#settingsBtn");
  await page.click('button:has-text("Dark")');
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate((prev) => document.querySelector("#preview svg") !== prev, svgBefore)).toBe(true);
});

test.describe("preview rendering fidelity", () => {
  async function type(page: import("@playwright/test").Page, md: string) {
    await page.evaluate((md) => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: md } });
    }, md);
  }

  test("PREV-01: headings, lists, nested lists, tables, blockquote, hr, inline styles", async ({ page }) => {
    await type(
      page,
      [
        "## Sub",
        "",
        "- a",
        "  - nested",
        "- b",
        "",
        "1. one",
        "2. two",
        "",
        "| H1 | H2 |",
        "| -- | -- |",
        "| c1 | c2 |",
        "",
        "> quoted",
        "",
        "---",
        "",
        "**bold** and _italic_ and `code`",
      ].join("\n"),
    );
    await expect(page.locator("#preview h2")).toHaveText("Sub");
    await expect(page.locator("#preview ul li ul li")).toHaveText("nested");
    await expect(page.locator("#preview ol li")).toHaveCount(2);
    await expect(page.locator("#preview table th")).toHaveCount(2);
    await expect(page.locator("#preview table td")).toHaveCount(2);
    await expect(page.locator("#preview blockquote")).toHaveText("quoted");
    await expect(page.locator("#preview hr")).toHaveCount(1);
    await expect(page.locator("#preview strong")).toHaveText("bold");
    await expect(page.locator("#preview em")).toHaveText("italic");
    await expect(page.locator("#preview p code")).toHaveText("code");
  });

  test("PREV-04: GFM task list items render as checkboxes", async ({ page }) => {
    await type(page, "- [ ] todo\n- [x] done");
    const boxes = page.locator('#preview li input[type="checkbox"]');
    await expect(boxes).toHaveCount(2);
    expect(await boxes.nth(0).isChecked()).toBe(false);
    expect(await boxes.nth(1).isChecked()).toBe(true);
  });

  test("PREV-05: a non-mermaid fenced code block renders as language-tagged <code>", async ({ page }) => {
    await type(page, "```js\nconst x = 1;\n```");
    const code = page.locator("#preview pre code");
    await expect(code).toContainText("const x = 1;");
    await expect(code).toHaveClass(/language-js/);
    await expect(page.locator("#preview pre.mermaid")).toHaveCount(0);
  });

  test("PREV-06: a footnote reference is a superscript link with a back-link and an sr-only heading", async ({ page }) => {
    await type(page, "Claim.[^1]\n\n[^1]: The source.");
    await expect(page.locator("#preview sup a").first()).toBeVisible();
    await expect(page.locator('#preview .footnotes a[href^="#"]')).not.toHaveCount(0);
    await expect(page.locator("#preview .footnotes .sr-only")).toHaveCount(1);
  });

  test("PREV-07: inline math renders inline (keeping its surrounding prose); block math renders as a display block", async ({ page }) => {
    await type(page, "inline $a+b$ here\n\n$$\nc+d\n$$");
    // Block math is wrapped in .katex-display; inline math is not.
    await expect(page.locator("#preview .katex-display")).toHaveCount(1);
    const total = await page.locator("#preview .katex").count();
    const display = await page.locator("#preview .katex-display .katex").count();
    expect(total - display).toBe(1); // exactly one inline .katex, outside any display wrapper
    // The prose either side of the inline math is preserved.
    const inlinePara = page.locator('#preview p:has-text("inline")');
    await expect(inlinePara.locator(".katex")).toHaveCount(1);
    await expect(inlinePara).toContainText("inline");
    await expect(inlinePara).toContainText("here");
  });
});
