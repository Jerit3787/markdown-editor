import { test, expect } from "./support/fixtures";

// Split mode's scroll-sync (Preview.svelte's initSyncScroll) mirrors one
// pane's scroll position onto the other as you scroll it — desired on
// both desktop (panes side by side) and mobile (panes stacked, see
// #body.mode-split #main in _layout.scss): "scrolling together" is the
// whole point of split view on any viewport.
test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("scrolling the editor pane moves the preview pane too, on mobile", async ({ page }) => {
    // Distinct heading+paragraph blocks (not a bare list of lines with no
    // blank-line separators, which Markdown collapses into one unbroken
    // paragraph) — sync interpolation needs multiple tagged preview
    // blocks to map between meaningfully.
    const longText = Array.from({ length: 60 }, (_, i) => `## Heading ${i}\n\nSome paragraph text for line ${i} to give real height.`).join("\n\n");
    await page.evaluate((t) => {
      const view = window.MDE.getEditor();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    }, longText);

    const preview = page.locator("#preview");
    const editorScroll = page.locator("#editor-mount .cm-scroller");

    const previewBefore = await preview.evaluate((el) => el.scrollTop);
    await editorScroll.evaluate((el) => (el.scrollTop = 500));
    await editorScroll.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(200);

    const previewAfter = await preview.evaluate((el) => el.scrollTop);
    expect(previewAfter).toBeGreaterThan(previewBefore);
  });
});

test.describe("desktop viewport", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("desktop split-mode scroll-sync still moves the preview when the editor scrolls to its own top", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    const longText = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n");
    await page.keyboard.type(longText);

    const preview = page.locator("#preview");
    const editorScroll = page.locator("#editor-mount .cm-scroller");

    await preview.evaluate((el) => (el.scrollTop = 300));
    await page.waitForTimeout(200);

    await editorScroll.evaluate((el) => (el.scrollTop = 500));
    await editorScroll.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(100);
    await editorScroll.evaluate((el) => (el.scrollTop = 2));
    await editorScroll.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(200);

    const previewAfter = await preview.evaluate((el) => el.scrollTop);
    expect(previewAfter).toBe(0);
  });
});

// followCursorInPreview() (a separate mechanism from initSyncScroll,
// firing on every cursor/selection change rather than scroll events) was
// the actual cause of the reported "scrolling on mobile sometimes jumps
// back to the top": its "already visible" check window is much narrower
// on mobile's short stacked panes, and mobile text editors commonly
// register a fast scroll-then-release touch gesture as a tap that plants
// the cursor at the release point — forcing the preview to snap to
// wherever the cursor now is, discarding wherever the user had actually
// scrolled the preview to. Confirmed unrelated to initSyncScroll: this
// reproduces with zero editor scrolling involved, purely from a cursor
// move.
test.describe("cursor-follow on mobile", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("moving the cursor does not force the preview back to the cursor's position on mobile", async ({ page }) => {
    const text = Array.from({ length: 60 }, (_, i) => `## Heading ${i}\n\nSome paragraph text for line ${i} to give real height.`).join("\n\n");
    await page.evaluate((t) => {
      const view = window.MDE.getEditor();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    }, text);

    const preview = page.locator("#preview");
    await preview.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 50));
    await page.waitForTimeout(150);
    const previewBefore = await preview.evaluate((el) => el.scrollTop);
    expect(previewBefore).toBeGreaterThan(0);

    // Moves the cursor to the very start of the document without any
    // scroll event at all — the same effect a scroll-release tap can have.
    await page.evaluate(() => {
      const view = window.MDE.getEditor();
      view.dispatch({ selection: { anchor: 5 } });
    });
    await page.waitForTimeout(200);

    const previewAfter = await preview.evaluate((el) => el.scrollTop);
    expect(previewAfter).toBe(previewBefore);
  });
});
