import { test, expect } from "./support/fixtures";

// Seeds a comment note via the app's own store API (stores/docs.ts's
// addDocNote), not a raw localStorage write — a raw write gets silently
// clobbered by the next debounced autosave, which only knows the
// Svelte store's own in-memory state and has no idea a note was added
// outside it (confirmed live: the "notes" field vanished from
// localStorage within ~1s of a direct write). A page.reload() after
// seeding is required too — CommentsPanel.svelte only calls its own
// loadEntries() (which turns notes into rendered .cm-comment-marker
// highlights) reactively off activeIdStore *changing*, or explicitly
// after its own UI submits a comment; neither fires just because
// doc.notes changed via addDocNote from outside the component. A full
// reload remounts the panel, whose effect then runs fresh against the
// now-correctly-persisted note.
async function seedComment(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "hello world" } });
    const { addDocNote } = await import("/src/stores/docs.ts");
    addDocNote(0, 5, "hello", "a test comment");
  });
  await page.reload();
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
}

test("a seeded comment renders as a highlight and shows in the panel", async ({ page }) => {
  await seedComment(page);
  await expect(page.locator(".cm-comment-marker")).toBeVisible();

  await page.click("#commentsBtn");
  await expect(page.locator('text="a test comment"')).toBeVisible();
});

test("selecting text shows the comment-draft popup without opening the Comments panel first", async ({ page }) => {
  // Regression: this used to require #commentsBtn clicked first (the
  // draft popup was gated on the panel being open) — on mobile, where
  // the panel is a bottom sheet whose backdrop blocks touch on the
  // editor while open, that made adding a comment impossible there.
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("hello world");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await expect(page.locator('button:has-text("Add comment")')).toBeVisible();
});

test("a comment can be added on a mobile viewport with the Comments sheet closed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".comments-panel")).toHaveClass(/collapsed/);

  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("hello world");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");

  await page.click('button:has-text("Add comment")');
  await page.fill("textarea", "a mobile comment");
  await page.click(".comment-draft-box button.primary-btn");

  await expect(page.locator(".cm-comment-marker")).toBeVisible();
});

test("selecting new text while the comment-draft box is open collapses it back to the Add comment button", async ({ page }) => {
  // Regression: creatingDraft (the flag that expands the draft box) used
  // to persist across selection changes — Editor.svelte's
  // commentDraftSyncListener fires a fresh commentDraft value on every
  // selection change, but the panel never reset creatingDraft in
  // response, so re-selecting different text while the box was still
  // open just re-anchored the already-expanded box instead of collapsing
  // it back to the plain button for the new selection.
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("hello world");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.click('button:has-text("Add comment")');
  await expect(page.locator(".comment-draft-box")).toBeVisible();

  // Select "world" instead, without cancelling or submitting the draft.
  // Clicking "Add comment" moved focus to that button, so the editor
  // needs focus back before keyboard selection commands reach it.
  await page.click("#editor-mount .cm-content");
  await page.keyboard.press("End");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");

  await expect(page.locator(".comment-draft-box")).not.toBeVisible();
  await expect(page.locator('button:has-text("Add comment")')).toBeVisible();
});

test("the comment-draft popup stays within the viewport when the selection is near the right edge on a narrow screen", async ({ page }) => {
  // Regression: .comment-draft-anchor positioned itself with the
  // selection's raw screen-x coordinate and no clamping against the
  // viewport width, so a selection near the right edge pushed the
  // (fixed 240px-wide) popup partly off-screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("word ".repeat(40));

  await page.evaluate(() => {
    const view = window.MDE.getEditor();
    // The rightmost position on the first wrapped visual line (the last
    // position whose coordsAtPos().top still matches the first line's,
    // right before it jumps to the next line) — its screen coordinate
    // sits close to the visible right edge.
    let bestPos = 0;
    let firstTop: number | undefined;
    for (let pos = 0; pos <= view.state.doc.length; pos++) {
      const rect = view.coordsAtPos(pos);
      if (!rect) continue;
      if (firstTop === undefined) firstTop = rect.top;
      else if (rect.top !== firstTop) break;
      bestPos = pos;
    }
    view.dispatch({ selection: { anchor: 0, head: bestPos } });
  });

  const anchor = page.locator(".comment-draft-anchor");
  await expect(anchor).toBeVisible();
  const box = await anchor.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("deleting a comment via the panel removes its highlight", async ({ page }) => {
  await seedComment(page);
  await page.click("#commentsBtn");
  await expect(page.locator(".cm-comment-marker")).toBeVisible();
  await page.click(".comment-delete-btn");
  await expect(page.locator(".cm-comment-marker")).toHaveCount(0);
});
