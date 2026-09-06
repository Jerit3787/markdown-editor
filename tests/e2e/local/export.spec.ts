import { test, expect } from "./support/fixtures";

test.describe("export", () => {
  test.beforeEach(async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("```mermaid\ngraph TD; A-->B;\n```");
    await expect(page.locator("#preview svg")).toBeVisible({ timeout: 5000 });
  });

  test("txt export succeeds", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("txt"))]);
    expect(download.suggestedFilename()).toMatch(/\.txt$/);
  });

  test("html export includes the rendered diagram, not raw fence source", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("html"))]);
    const path = await download.path();
    const fs = await import("node:fs/promises");
    const html = path ? await fs.readFile(path, "utf-8") : "";
    expect(html).toContain("<svg");
    expect(html).not.toContain("```mermaid");
  });

  test("pdf export succeeds", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("pdf"))]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });
});

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.describe("markdown export", () => {
  async function readMd(page: import("@playwright/test").Page) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("md"))]);
    const p = await download.path();
    const fs = await import("node:fs/promises");
    return { file: download.suggestedFilename(), content: p ? await fs.readFile(p, "utf-8") : "" };
  }

  test("EXP-01: resolves a diagram ref to its source, an image ref to a data URI, and re-serializes metadata + citations", async ({ page }) => {
    await page.evaluate(async (b64) => {
      const { setDocDiagram, setActiveDocMetadata, setActiveDocCitations } = await import("/src/stores/docs.ts");
      setDocDiagram("dkey", "flowchart TD\n  A --> B");
      setActiveDocMetadata([{ key: "Title", value: "Exported" }]);
      setActiveDocCitations({
        prefs: { markerStyle: "pandoc", bibliographySource: "structured", displayStyle: "numbered" },
        bibliography: [{ key: "S1", author: "Smith", year: "2020", text: "A Title." }],
      });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.MDE.insertImageWithUpload!(new File([bytes], "pic.png", { type: "image/png" }));
    }, PIXEL);
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "See [@S1].\n\n![pic](pic.png)\n\n```mermaid\ndkey\n```" } });
    });

    const { content } = await readMd(page);
    expect(content).toContain("Title: Exported");
    expect(content).toContain("flowchart TD");
    expect(content).not.toMatch(/```mermaid\ndkey\n```/);
    expect(content).toContain("![pic](data:image/png;base64,");
    expect(content).toContain("[@S1]: A Title.");
  });

  test("EXP-02: the exported .md re-imports to an equivalent document", async ({ page }) => {
    await page.evaluate(async () => {
      const { setActiveDocMetadata } = await import("/src/stores/docs.ts");
      setActiveDocMetadata([{ key: "Author", value: "Ada" }]);
    });
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Heading\n\nBody paragraph." } });
    });
    const { content } = await readMd(page);

    const reimported = await page.evaluate(
      (md) =>
        import("/src/stores/docs.ts").then((m) => {
          const d = m.createDoc({ name: "Reimported", content: md });
          return { content: d.content, metadata: d.metadata ?? [] };
        }),
      content,
    );
    expect(reimported.content.trim()).toBe("# Heading\n\nBody paragraph.");
    expect(reimported.metadata).toEqual([{ key: "Author", value: "Ada" }]);
  });
});

test.describe("txt and html export content", () => {
  async function readExport(page: import("@playwright/test").Page, fmt: "txt" | "html") {
    const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate((f) => window.MDE.exportAs(f), fmt)]);
    const p = await download.path();
    const fs = await import("node:fs/promises");
    return p ? await fs.readFile(p, "utf-8") : "";
  }

  test("EXP-03: .txt export is the rendered text — no markdown syntax", async ({ page }) => {
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Big Heading\n\nSome **bold** and _italic_ words." } });
    });
    const txt = await readExport(page, "txt");
    expect(txt).toContain("Big Heading");
    expect(txt).toContain("bold");
    expect(txt).not.toMatch(/^#\s/m);
    expect(txt).not.toContain("**");
    expect(txt).not.toContain("_italic_");
  });

  test("EXP-05: .html export inlines the stylesheet, and KaTeX CSS when the doc has math", async ({ page }) => {
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "text $x^2$ more" } });
    });
    await expect(page.locator("#preview .katex")).toBeVisible();
    const html = await readExport(page, "html");
    expect(html).toMatch(/<style>[\s\S]*body\s*\{/);
    expect(html.toLowerCase()).toContain(".katex");
  });

  test("EXP-06: the exported .html can't be broken out of — safe <title>, and a </style> in custom CSS is neutralized", async ({ page }) => {
    // currentFileBase() strips \ / : * ? " < > | before the title is ever
    // built, and buildStandaloneHtml() also escapeHtml()s it — either way
    // the <title> never carries markup.
    await page.fill("#docTitle", "<script>alert(1)</script>");
    await page.keyboard.press("Enter");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "body" } });
      localStorage.setItem("mde:customExportCss", "body{}</style><script>window.__x=1</script>");
    });
    const html = await readExport(page, "html");
    expect(html).toMatch(/<title>[^<>]*<\/title>/);
    expect(html).not.toContain("<title><script>");
    // The custom-CSS </style> is escaped so it can't close the tag early.
    expect(html).toContain("<\\/style><script>");
    expect(html).not.toMatch(/<style>[^]*<\/style><script>window\.__x/);
  });
});

test("EXP-08: the export filename derives from the sanitized document name", async ({ page }) => {
  await page.fill("#docTitle", "Quarterly: Report? <v2>");
  await page.keyboard.press("Enter");
  const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("md"))]);
  expect(download.suggestedFilename()).toBe("Quarterly- Report- -v2-.md");
});
