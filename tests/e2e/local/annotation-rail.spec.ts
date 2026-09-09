import { test, expect } from "./support/fixtures";

// SP-A — the annotation rail anchors each card next to the line it
// refers to (when the editor pane is visible), follows the editor's
// scroll, and can be flattened to a plain list from the header toggle.

async function seedTwoComments(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const view = window.MDE.getEditor();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "First line to note.\n" + "filler\n".repeat(40) + "A much later line to note.\n" },
    });
    const { addDocNote } = await import("/src/stores/docs.ts");
    const text = view.state.doc.toString();
    addDocNote(0, 5, "First", "top note");
    const laterAt = text.indexOf("later");
    addDocNote(laterAt, laterAt + 5, "later", "bottom note");
  });
  await page.reload();
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await page.click("#commentsBtn");
}

test("cards anchor to their line, follow the editor scroll, and flatten to a list on toggle", async ({ page }) => {
  await seedTwoComments(page);

  const cards = page.locator(".annotation-rail-canvas.anchored .annotation-rail-slot");
  await expect(cards).toHaveCount(2);

  const topOf = (i: number) => cards.nth(i).evaluate((el) => parseFloat((el as HTMLElement).style.top || "0"));

  // Document order: the "top note" card sits above the "bottom note" one.
  await expect.poll(() => topOf(0)).toBeLessThan(await topOf(1));

  // The "bottom note" anchors ~40 lines down, off-screen at rest —
  // scrolling the editor to it moves its card.
  const laterCardBefore = await topOf(1);
  await page.locator("#editor-mount .cm-scroller").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => topOf(1)).not.toBe(laterCardBefore);

  // Header toggle → plain list, no absolute positioning.
  await page.locator(".annotation-rail-header").getByRole("button", { name: "List" }).click();
  await expect(page.locator(".annotation-rail-canvas:not(.anchored)")).toBeVisible();
  await expect(page.locator(".annotation-rail-canvas .annotation-rail-slot").first()).not.toHaveAttribute("style", /position:\s*absolute/);
});

test("adding comments through the draft box on a live doc never trips a reactive loop", async ({ page }) => {
  const loopErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /effect_update_depth_exceeded|Maximum update depth/i.test(m.text())) loopErrors.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/effect_update_depth_exceeded/i.test(String(e))) loopErrors.push(String(e));
  });

  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await page.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({
      changes: { from: 0, to: cm.state.doc.length, insert: "First paragraph to annotate.\n\n" + "filler line\n".repeat(15) + "\nLast paragraph to annotate." },
    });
  });
  await page.click("#editor-mount .cm-content");

  const addOne = async (needle: string, body: string) => {
    await page.evaluate((n) => {
      const cm = window.MDE.getEditor();
      const i = cm.state.doc.toString().indexOf(n);
      cm.dispatch({ selection: { anchor: i, head: i + n.length } });
      cm.focus();
    }, needle);
    await page.locator(".comment-add-btn").click();
    await page.fill(".comment-draft-box textarea", body);
    await page.locator(".comment-draft-box").getByRole("button", { name: "Comment" }).click();
    await page.waitForTimeout(400);
  };
  await addOne("First paragraph to annotate.", "does this still hold?");
  await addOne("Last paragraph to annotate.", "and this one?");

  await page.locator("#editor-mount .cm-scroller").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(300);
  await page.locator("#editor-mount .cm-scroller").evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(300);

  expect(loopErrors, loopErrors.join("\n")).toEqual([]);
  await expect(page.locator(".annotation-rail .annotation-card")).toHaveCount(2);
});

test("hovering an in-text comment highlight lights up its card", async ({ page }) => {
  await seedTwoComments(page);
  await page.locator(".annotation-rail-header").getByRole("button", { name: "List" }).click(); // list mode — both cards on screen

  await page.locator(".cm-comment-marker").first().hover();
  await expect(page.locator(".annotation-card.active")).toHaveCount(1);
});
