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
// initSyncScroll's "preview near its own bottom" branch used to scroll the
// editor to its end via view.dispatch(EditorView.scrollIntoView(doc.length,
// {y:"end"})) instead of a plain scrollTop write like every other branch
// here (including its own "editor near its bottom" counterpart). That CM6
// effect resolves asynchronously — the editor's scrollTop doesn't move
// until a later animation frame, well after the syncingScroll guard's own
// single requestAnimationFrame has already reset it — and it isn't
// guaranteed to land exactly at scrollHeight - clientHeight. On a real
// device that combination let a follow-up scroll event land outside the
// "already at the end" slack the editor's own check uses, falling through
// to the normal interpolation branch and yanking both panes back toward
// mid-document — reported live as "the view scrolls itself back up with no
// touching," after scrolling to the end of a short document. Confirmed by
// reproducing the CM6 effect's deferred-resolution: dispatching it left
// scrollTop unmoved until a later frame, whereas a plain write (the fix)
// takes effect in the same tick as every other edge-case branch.
test.describe("preview-at-bottom sync on mobile", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("scrolling the preview to its own bottom moves the editor to its end in the same tick, not a later frame", async ({ page }) => {
    const longText = Array.from({ length: 60 }, (_, i) => `## Heading ${i}\n\nSome paragraph text for line ${i} to give real height.`).join("\n\n");
    await page.evaluate((t) => {
      const view = window.MDE.getEditor();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    }, longText);

    // Let CM6 fully settle its line-height measurement after the big doc
    // replacement above (unrelated lazy measurement, not the sync code
    // under test), then dispatch the preview's own "scroll" event and read
    // the editor's scrollTop back in the very same synchronous JS turn —
    // not via separate Playwright evaluate() round-trips (each one is a
    // real CDP round-trip that takes longer than a frame on its own,
    // which would hide exactly the async-vs-sync distinction under test).
    const editorImmediately = await page.evaluate(async () => {
      const view = window.MDE.getEditor();
      const preview = document.getElementById("preview")!;
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));
      view.scrollDOM.scrollTop = 500;
      for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));

      preview.scrollTop = preview.scrollHeight - preview.clientHeight;
      preview.dispatchEvent(new Event("scroll"));
      // No await/rAF here — this must already reflect the sync write.
      return view.scrollDOM.scrollTop;
    });

    const editorMax = await page.evaluate(() => {
      const el = window.MDE.getEditor().scrollDOM;
      return el.scrollHeight - el.clientHeight;
    });
    expect(editorImmediately).toBeGreaterThanOrEqual(editorMax - 8);
  });
});

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
