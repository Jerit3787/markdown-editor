import { test, expect } from "./support/fixtures";

const CSP_RE = /Content Security Policy|Refused to (load|execute|connect|apply|frame)/i;

test.describe("Content-Security-Policy does not break the app", () => {
  test("the CSP meta tag is present and enforcing", async ({ page }) => {
    const content = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(content).toMatch(/^default-src 'self'/);
    expect(content).toContain("object-src 'none'");
  });

  test("editing, math, Mermaid, images and menus produce no CSP violation", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && CSP_RE.test(m.text())) violations.push(m.text());
    });

    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await page.click("#editor-mount .cm-content");
    await page.evaluate(() => {
      const cm = window.MDE.getEditor();
      cm.dispatch({
        changes: {
          from: 0,
          to: cm.state.doc.length,
          insert:
            "# CSP probe\n\nInline math $x^2 + 1$ and a data image ![d](data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=) and a remote one ![r](https://raw.githubusercontent.com/Jerit3787/markdown-editor/master/client/public/logo.svg)\n\n```mermaid\ngraph TD; A-->B;\n```\n",
        },
      });
    });

    await expect(page.locator("#preview-mount .katex").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#preview-mount img[src^="data:"]').first()).toBeVisible();
    await expect(page.locator("#preview-mount pre.mermaid svg, #preview-mount .mermaid svg").first()).toBeVisible({ timeout: 10000 });

    for (const id of ["#fileMenuBtn", "#editMenuBtn", "#viewMenuBtn", "#helpMenuBtn"]) {
      await page.click(id);
      await page.keyboard.press("Escape");
    }
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.press("Escape");

    expect(violations, `CSP violations:\n${violations.join("\n")}`).toEqual([]);
  });

  test("HTML / Markdown / PDF export run without a CSP script violation", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && CSP_RE.test(m.text())) violations.push(m.text());
    });
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await page.click("#editor-mount .cm-content");
    await page.evaluate(() => {
      const cm = window.MDE.getEditor();
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "# Export probe\n\nSome **bold** text.\n" } });
    });
    // Wait for the preview to render — exportAs reads #preview's DOM.
    await expect(page.locator("#preview-mount h1", { hasText: "Export probe" })).toBeVisible({ timeout: 10000 });

    for (const fmt of ["md", "html"] as const) {
      const dl = page.waitForEvent("download", { timeout: 15000 });
      await page.evaluate((f) => window.MDE.exportAs(f), fmt);
      expect((await dl).suggestedFilename()).toMatch(new RegExp(`\\.${fmt === "md" ? "md" : "html"}$`));
    }
    // PDF pulls in html2pdf.js + jspdf — the runtime 'unsafe-eval' check.
    const pdf = page.waitForEvent("download", { timeout: 30000 });
    await page.evaluate(() => window.MDE.exportAs("pdf"));
    expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);

    expect(violations, `CSP violations during export:\n${violations.join("\n")}`).toEqual([]);
  });
});
