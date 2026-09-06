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

async function dropFile(page: import("@playwright/test").Page, name: string, type: string, bytes: number[] | number) {
  await page.evaluate(
    ({ name, type, bytes }) => {
      const data = typeof bytes === "number" ? new Uint8Array(bytes) : Uint8Array.from(bytes);
      const file = new File([data], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector("#editor-mount .cm-content")!;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: r.x + 5, clientY: r.y + 5, bubbles: true, cancelable: true }));
    },
    { name, type, bytes },
  );
}

const PIXEL_BYTES = Array.from(Uint8Array.from(atob(PIXEL_PNG_BASE64), (c) => c.charCodeAt(0)));

test("IMG-03: dropping an image file onto the editor embeds it", async ({ page }) => {
  await dropFile(page, "dropped.png", "image/png", PIXEL_BYTES);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[dropped\]\(dropped\.png\)/);
  const images = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]")[0]?.images ?? {});
  expect(images["dropped.png"]).toMatch(/^data:image\/png;base64,/);
});

test("IMG-04: dropping an oversized image inserts the too-large marker, not the image", async ({ page }) => {
  await dropFile(page, "huge.png", "image/png", 3 * 1024 * 1024);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("huge.png: image too large, 2MB max");
});

test("IMG-05: dropping a non-image file is ignored (no marker, no ref)", async ({ page }) => {
  await dropFile(page, "notes.txt", "text/plain", Array.from(new TextEncoder().encode("hello")));
  await page.waitForTimeout(200);
  const doc = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());
  expect(doc).not.toContain("notes.txt");
  expect(doc).not.toContain("Encoding");
});

test("IMG-07: switching documents before the FileReader resolves drops the pending image", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "imgother", name: "Img Other" });
    switchDoc("e2e-doc-1");
  });
  // ~500KB (< 2MB) so the read genuinely outlasts the synchronous switchDoc.
  await page.evaluate(() => {
    const file = new File([new Uint8Array(500 * 1024)], "raced.png", { type: "image/png" });
    window.MDE.insertImageWithUpload!(file);
    window.MDE.switchDoc("imgother");
  });
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    return {
      other: docs.find((d: { id: string }) => d.id === "imgother"),
      orig: docs.find((d: { id: string }) => d.id === "e2e-doc-1"),
      editor: window.MDE.getEditor().state.doc.toString(),
    };
  });
  expect(Object.keys(state.other?.images ?? {})).not.toContain("raced.png");
  expect(Object.keys(state.orig?.images ?? {})).not.toContain("raced.png");
  expect(state.other?.content ?? "").not.toContain("Encoding");
  expect(state.editor).not.toContain("Encoding");
});

test("IMG-15: a ![](key) reference renders as an <img> with the resolved data URI in the preview", async ({ page }) => {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.MDE.insertImageWithUpload!(new File([bytes], "shown.png", { type: "image/png" }));
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/!\[shown\]\(shown\.png\)/);

  const img = page.locator('#preview img[alt="shown"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
});
