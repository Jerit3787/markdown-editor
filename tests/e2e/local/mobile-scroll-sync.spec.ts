import { test, expect } from "./support/fixtures";

// Split mode's scroll-sync (Preview.svelte's initSyncScroll) mirrors one
// pane's scroll position onto the other — correct on desktop, where the
// panes sit side by side and read as one document shown two ways. Below
// the 780px breakpoint split mode stacks them vertically instead (see
// #body.mode-split #main in _layout.scss), where they read as two
// independent scrollable sections — syncing them there means scrolling
// one pane near its own top can silently reset an already-scrolled other
// pane back to the top.
test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("scrolling the editor pane near its own top does not reset the preview pane", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    const longText = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n");
    await page.keyboard.type(longText);

    const preview = page.locator("#preview");
    const editorScroll = page.locator("#editor-mount .cm-scroller");

    await preview.evaluate((el) => (el.scrollTop = 300));
    await page.waitForTimeout(200);
    const previewBefore = await preview.evaluate((el) => el.scrollTop);
    expect(previewBefore).toBeGreaterThan(0);

    await editorScroll.evaluate((el) => (el.scrollTop = 500));
    await editorScroll.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(100);
    await editorScroll.evaluate((el) => (el.scrollTop = 2));
    await editorScroll.evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(200);

    const previewAfter = await preview.evaluate((el) => el.scrollTop);
    expect(previewAfter).toBe(previewBefore);
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
