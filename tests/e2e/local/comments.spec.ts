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

test("deleting a comment via the panel removes its highlight", async ({ page }) => {
  await seedComment(page);
  await page.click("#commentsBtn");
  await expect(page.locator(".cm-comment-marker")).toBeVisible();
  await page.click(".comment-delete-btn");
  await expect(page.locator(".cm-comment-marker")).toHaveCount(0);
});
