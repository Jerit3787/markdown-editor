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
  await expect
    .poll(() => page.evaluate((prev) => document.querySelector("#preview svg") !== prev, svgBefore))
    .toBe(true);
});
