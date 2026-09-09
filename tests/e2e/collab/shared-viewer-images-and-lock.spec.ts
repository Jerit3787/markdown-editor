import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, expectEditorContains, BASE } from "./support/collab";

// A 1×1 red PNG — enough for the browser to actually decode and render.
const PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a viewer joining a shared doc sees its managed image, not a broken ref", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await ownerWithDoc(owner, "img-owner-e2e", "");
  await owner.evaluate((url) => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "# Title\n\n![logo](logo.png)\n" } });
    window.MDE.setDocImage("logo.png", url);
  }, PIXEL_PNG);

  const shareUrl = await shareAnyoneLink(owner, "Viewer");
  await joinSharedWorkspace(viewer, shareUrl);
  await expectEditorContains(viewer, "![logo](logo.png)");

  // The preview <img> for that ref must resolve to the inlined data URL —
  // a preview-mode viewer never gets the live imagesMap sync otherwise.
  const img = viewer.locator('#preview-mount img[alt="logo"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^data:image\/png/);
  const decoded = await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
  expect(decoded).toBe(true);
});

test("a viewer opening a share link never flashes an editable editor", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await ownerWithDoc(owner, "lock-owner-e2e", "Viewer-locked content");
  const shareUrl = await shareAnyoneLink(owner, "Viewer");

  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });

  // collab.ts init() applies the pessimistic lock synchronously, so the
  // editor is read-only + preview-locked from the first frame. Sample
  // repeatedly across the whole join to prove it never flips editable.
  for (let i = 0; i < 10; i++) {
    const readOnly = await viewer.evaluate(() => window.MDE.getEditor().state.readOnly);
    expect(readOnly).toBe(true);
    await viewer.waitForTimeout(150);
  }
  await expectEditorContains(viewer, "Viewer-locked content");
  // Settled state: still locked to Viewing.
  expect(await viewer.evaluate(() => window.MDE.getEditor().state.readOnly)).toBe(true);
});
