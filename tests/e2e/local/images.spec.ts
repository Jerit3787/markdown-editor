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

test("Upload new image button inside the modal inserts a new image and closes the modal", async ({ page }) => {
  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();

  await page.locator("#imagesUploadInput").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(PIXEL_PNG_BASE64, "base64"),
  });

  await expect(page.getByText("Images in this document")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);
});

test("Replace on a row overwrites the same key without changing the document text", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(file);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);
  const originalText = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());

  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
  await page.click('button[aria-label="Replace pixel.png"]');

  const RED_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await page.locator("#imagesReplaceInput").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(RED_PIXEL_PNG_BASE64, "base64"),
  });

  await expect(page.getByText("Images in this document")).toBeVisible();

  const finalText = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());
  expect(finalText).toBe(originalText);

  const images = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return docs[0]?.images ?? {};
  });
  expect(images["pixel.png"]).not.toBe("data:image/png;base64," + PIXEL_PNG_BASE64);
  expect(images["pixel.png"]).toMatch(/^data:image\/png;base64,/);
});

test("Replacing with an oversized file shows an error and leaves the original image untouched", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    await window.MDE.insertImageWithUpload!(file);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[pixel\]\(pixel\.png\)/);
  const originalImages = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return docs[0]?.images ?? {};
  });

  await page.click('button[title="Image"]');
  await expect(page.getByText("Images in this document")).toBeVisible();
  await page.click('button[aria-label="Replace pixel.png"]');

  await page.locator("#imagesReplaceInput").setInputFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(3 * 1024 * 1024),
  });

  await expect(page.getByText("Image too large (2MB max).")).toBeVisible();
  const imagesAfter = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return docs[0]?.images ?? {};
  });
  expect(imagesAfter["pixel.png"]).toBe(originalImages["pixel.png"]);
});
