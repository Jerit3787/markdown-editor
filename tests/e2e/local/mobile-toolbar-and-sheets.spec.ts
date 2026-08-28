import { test, expect } from "./support/fixtures";

// Regression coverage for a run of mobile-only CSS bugs found via manual
// testing on production (v1.28.0 -> v1.29.1): a bottom sheet's backdrop
// not actually blocking the page behind it, that same fix later painting
// over the sheet's own content, and two toolbar-adjacent button groups
// silently missing the shared mobile touch-target size bump. Asserting on
// actual click-target/visible behavior (via elementFromPoint and bounding
// boxes) rather than raw z-index/CSS values, so these keep catching a
// regression even if the underlying stacking values are renumbered later.
test.use({ viewport: { width: 390, height: 844 } });

test("mobile Comments sheet backdrop blocks the top bar behind it, without dimming the sheet itself", async ({ page }) => {
  await page.click("#commentsBtn");
  await expect(page.locator(".comments-panel")).not.toHaveClass(/collapsed/);
  await expect(page.locator(".mobile-sheet-backdrop")).toHaveClass(/visible/);

  const topbarBtn = page.locator("#versionHistoryBtn");
  const topbarBox = (await topbarBtn.boundingBox())!;
  const elementOverTopbar = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".mobile-sheet-backdrop") !== null, {
    x: topbarBox.x + topbarBox.width / 2,
    y: topbarBox.y + topbarBox.height / 2,
  });
  expect(elementOverTopbar, "backdrop should intercept clicks over the top bar while the sheet is open").toBe(true);

  const panelHeader = page.locator(".comments-panel-header");
  const headerBox = (await panelHeader.boundingBox())!;
  const elementOverPanel = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".comments-panel") !== null, {
    x: headerBox.x + headerBox.width / 2,
    y: headerBox.y + headerBox.height / 2,
  });
  expect(elementOverPanel, "the sheet's own content should stay on top of its backdrop, not underneath it").toBe(true);
});

test("mobile sidebar sheet backdrop blocks the top bar behind it, without dimming the sheet itself", async ({ page }) => {
  await page.click("#sidebarToggleOut");
  await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);
  await expect(page.locator("#sidebarBackdrop")).toHaveClass(/visible/);

  const topbarBtn = page.locator("#commentsBtn");
  const topbarBox = (await topbarBtn.boundingBox())!;
  const elementOverTopbar = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("#sidebarBackdrop") !== null, {
    x: topbarBox.x + topbarBox.width / 2,
    y: topbarBox.y + topbarBox.height / 2,
  });
  expect(elementOverTopbar, "backdrop should intercept clicks over the top bar while the sidebar sheet is open").toBe(true);

  const sidebarHeader = page.locator("#sidebarHeader");
  const headerBox = (await sidebarHeader.boundingBox())!;
  const elementOverSidebar = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("#sidebar") !== null, {
    x: headerBox.x + headerBox.width / 2,
    y: headerBox.y + headerBox.height / 2,
  });
  expect(elementOverSidebar, "the sidebar sheet's own content should stay on top of its backdrop, not underneath it").toBe(true);
});

test("mobile toolbar buttons (sidebar toggle, view selector) match the size of ordinary formatting buttons", async ({ page }) => {
  const boldBtn = page.locator(".toolbar-buttons button", { hasText: "B" }).first();
  const boldBox = (await boldBtn.boundingBox())!;

  const sidebarToggle = page.locator("#sidebarToggleOut");
  const sidebarToggleBox = (await sidebarToggle.boundingBox())!;
  expect(sidebarToggleBox.height).toBeGreaterThanOrEqual(boldBox.height - 2);
  expect(sidebarToggleBox.width).toBeGreaterThanOrEqual(boldBox.width - 2);

  const viewSelectorButtons = page.locator(".view-selector button");
  await expect(viewSelectorButtons).toHaveCount(2);
  for (const btn of await viewSelectorButtons.all()) {
    const box = (await btn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(boldBox.height - 2);
    expect(box.width).toBeGreaterThanOrEqual(boldBox.width - 2);
  }
});

test("mobile share button renders as a circle, not an oval", async ({ page }) => {
  const shareBtn = page.locator("#shareBtn");
  await expect(shareBtn).toBeVisible();
  const box = (await shareBtn.boundingBox())!;
  expect(Math.abs(box.width - box.height), `expected a square box, got ${box.width}x${box.height}`).toBeLessThanOrEqual(1);
});

test("mobile toolbar overflow menu wraps buttons into a grid instead of stacking one per line", async ({ page }) => {
  const overflowBtn = page.locator(".toolbar-overflow > button.icon-btn");
  await overflowBtn.click();

  const menuButtons = page.locator(".toolbar-overflow-menu button");
  await expect(menuButtons.first()).toBeVisible();
  const firstBox = (await menuButtons.nth(0).boundingBox())!;
  const secondBox = (await menuButtons.nth(1).boundingBox())!;

  expect(
    Math.abs(firstBox.y - secondBox.y),
    `the first two overflowed buttons should sit on the same row (y=${firstBox.y} vs y=${secondBox.y}), not stack one per line`,
  ).toBeLessThanOrEqual(2);
});

test("mobile toolbar row height stays stable across view modes", async ({ page }) => {
  const topbarRow = page.locator("#topbar-row");

  const splitHeight = (await topbarRow.boundingBox())!.height;

  // Toggle the editor pane off -> preview-only, which hides #toolbar's
  // formatting buttons (but not .view-selector's).
  await page.locator(".view-selector button").nth(0).click();
  const previewOnlyHeight = (await topbarRow.boundingBox())!.height;

  expect(
    Math.abs(splitHeight - previewOnlyHeight),
    `toolbar row height shifted from ${splitHeight}px (split) to ${previewOnlyHeight}px (preview-only)`,
  ).toBeLessThanOrEqual(1);
});

test("the editor's font-size is at least 16px on mobile, to avoid iOS Safari's zoom-on-focus", async ({ page }) => {
  // Regression: EditorView.theme() (editor-theme.ts) sets .cm-content's
  // font-size directly, compiled against a CodeMirror-generated unique
  // class — a plain page-CSS media-query rule targeting bare .cm-content
  // (previously in _editor-preview.scss) can never out-specify that,
  // so the intended mobile override silently never took effect and the
  // page kept auto-zooming on focus. The real fix nests the mobile
  // override inside editorTheme's own theme() call instead.
  const fontSize = await page.locator("#editor-mount .cm-content").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
});
