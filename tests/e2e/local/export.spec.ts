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
