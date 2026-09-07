import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, editorText, expectEditorContains } from "./support/collab";

// A 1×1 transparent PNG — same fixture the local image specs use.
const PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// IMG-06: while `![Encoding raced.png…]()` sits in the editor during the
// FileReader read, imageMarkerField (a CM6 DecorationSet that
// .map(tr.changes)es every transaction) must remap the placeholder when a
// COLLABORATOR's insertion lands above it, so the real ![alt](key) swaps
// in at the shifted position. IMG-07 covers only the single-editor "switch
// away mid-read → drop it" half. The FileReader window is made
// deterministic with a per-page stub rather than raced.
test("IMG-06: an upload placeholder tracks its position across a collaborator's concurrent insert", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  // Test-only, editor A's page only: defer FileReader.onload by 1.5s so
  // B's edit reliably lands inside the read window. readImageAsDataURL
  // sets `onload` before calling readAsDataURL, so wrapping it here works.
  await a.addInitScript(() => {
    const Real = window.FileReader;
    class SlowFileReader extends Real {
      readAsDataURL(blob: Blob) {
        const orig = this.onload;
        this.onload = (e: ProgressEvent<FileReader>) => setTimeout(() => orig && (orig as (ev: ProgressEvent<FileReader>) => void).call(this, e), 1500);
        super.readAsDataURL(blob);
      }
    }
    (window as unknown as { FileReader: typeof FileReader }).FileReader = SlowFileReader;
  });

  await ownerWithDoc(a, "imgmark-a-e2e", "");
  // Set the three lines atomically — keyboard.type of "\n" would trigger
  // list-continuation / auto-indent.
  await a.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "LINE1\nLINE2\nLINE3" } });
  });
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "LINE3");
  await expectEditorContains(a, "LINE1"); // A settled in collab mode

  // A starts an upload at end-of-doc.
  await a.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const cm = window.MDE.getEditor();
    window.MDE.insertImageWithUpload!(new File([bytes], "raced.png", { type: "image/png" }), cm.state.doc.length);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => editorText(a)).toContain("![Encoding raced.png…]()");

  // During the 1.5s stubbed read, B inserts a 7-char prefix at offset 0.
  await b.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, insert: "PREFIX " } });
  });
  await expectEditorContains(a, "PREFIX LINE1"); // remote insert reached A before the read resolves

  // Read resolves → the swap-in lands at the SHIFTED tail (contiguous with
  // LINE3), not 7 chars early where the pre-insert offset would have put
  // it.
  await expect.poll(() => editorText(a), { timeout: 15000 }).toBe("PREFIX LINE1\nLINE2\nLINE3![raced](raced.png)");
  expect(await editorText(a)).not.toContain("Encoding");

  // B converges to the same text.
  await expect.poll(() => editorText(b), { timeout: 15000 }).toBe("PREFIX LINE1\nLINE2\nLINE3![raced](raced.png)");

  await aCtx.close();
  await bCtx.close();
});
