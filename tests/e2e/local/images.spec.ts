import { test, expect } from "./support/fixtures";

const PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("pasting an image embeds it as a data URI", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(file);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);
  const images = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return docs[0]?.images ?? {};
  });
  expect(Object.keys(images)).toContain("pixel.png");
  expect(images["pixel.png"]).toMatch(/^data:image\/png;base64,/);
});

test("an oversized image shows the inline error instead of uploading", async ({ page }) => {
  await page.evaluate(async () => {
    const bigFile = new File([new Uint8Array(3 * 1024 * 1024)], "big.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(bigFile);
  });
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("big.png: image too large, 2MB max");
});

test("clicking the toolbar Insert image button opens the Images modal", async ({ page }) => {
  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
});

test("clicking a thumbnail in the Images modal inserts a reference and closes the modal", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(file);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);

  await page.evaluate(() => {
    const view = window.MDE.getEditor();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });

  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
  await page.click(".image-item img");

  await expect(page.getByText("Images in this document")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("![pixel](pixel.png)![pixel](pixel.png)");
});
