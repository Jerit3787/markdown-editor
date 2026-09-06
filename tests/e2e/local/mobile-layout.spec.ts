import { test, expect } from "./support/fixtures";

const MOBILE = { width: 390, height: 844 };

test("MOB-01: below the breakpoint the split layout stacks editor above preview", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.evaluate(() => window.MDE.getEditor().dispatch({ changes: { from: 0, insert: "# Title\n\nbody" } }));

  const dir = await page.evaluate(() => getComputedStyle(document.getElementById("main")!).flexDirection);
  expect(dir).toBe("column");

  const editorBox = (await page.locator("#editorPane").boundingBox())!;
  const previewBox = (await page.locator("#previewPane").boundingBox())!;
  expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(previewBox.y + 1); // stacked, not side-by-side
});

test("MOB-14: crossing the breakpoint re-lays-out without a reload", async ({ page }) => {
  // Desktop first — side by side.
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("main")!).flexDirection)).toBe("row");

  await page.setViewportSize(MOBILE);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById("main")!).flexDirection)).toBe("column");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById("main")!).flexDirection)).toBe("row");
});

test("MOB-07: the mobile sidebar sheet resets to the Documents tab each time it opens", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.click("#sidebarToggleOut");
  await expect(page.locator(".doclist-tabs")).toBeVisible();

  await page.click('.doclist-tabs button:has-text("Headings")');
  await expect(page.locator('.doclist-tabs button.active:has-text("Headings")')).toBeVisible();

  // dismiss via the in-sheet toggle (the backdrop covers the toolbar while open), then reopen
  await page.click("#sidebarToggleIn");
  await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);
  await page.click("#sidebarToggleOut");
  await expect(page.locator('.doclist-tabs button.active:has-text("Documents")')).toBeVisible();
});

test("MOB-08: the Headings tab is read-only navigation and tapping a heading closes the sheet", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.evaluate(() => {
    const v = window.MDE.getEditor();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Alpha\n\ntext\n\n## Beta\n\nmore" } });
  });

  await page.click("#sidebarToggleOut");
  await page.click('.doclist-tabs button:has-text("Headings")');
  const outline = page.locator(".doclist-headings-tab .outline-item");
  await expect(outline).toHaveCount(2);
  // no rename/menu affordance on an outline item — it's plain navigation
  await expect(page.locator(".doclist-headings-tab .doc-menu-btn")).toHaveCount(0);

  await outline.filter({ hasText: "Beta" }).click();
  await expect(page.locator("#sidebarBackdrop")).not.toHaveClass(/visible/);
  // and the editor selection moved to the "## Beta" line
  const lineText = await page.evaluate(() => {
    const s = window.MDE.getEditor().state;
    return s.doc.lineAt(s.selection.main.head).text;
  });
  expect(lineText).toContain("Beta");
});
