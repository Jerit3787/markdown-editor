import { test, expect } from "./support/fixtures";

test("UI-1: top-bar icon buttons are circular", async ({ page }) => {
  const radius = (sel: string) =>
    page.locator(sel).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { br: parseFloat(cs.borderRadius), w: el.getBoundingClientRect().width };
    });

  const vh = await radius("#versionHistoryBtn");
  expect(vh.br).toBeGreaterThanOrEqual(vh.w * 0.4); // ~50% → half the box

  const settings = await radius("#settingsBtn");
  expect(settings.br).toBeGreaterThanOrEqual(settings.w * 0.4);

  // The formatting-toolbar overflow ("⋯") button — forced visible by a
  // narrow viewport — keeps a small radius (it's a dropdown-list trigger,
  // not a chrome button). Its rule (.toolbar-overflow .icon-btn) already
  // sets border-radius: 5px + width/height: auto and wins on specificity.
  await page.setViewportSize({ width: 640, height: 800 });
  const overflowBtn = page.locator(".toolbar-overflow .icon-btn");
  await expect(overflowBtn).toBeVisible();
  const r = await overflowBtn.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius));
  expect(r).toBeLessThan(12);
});

test("UI-5: hovering a top-bar icon button shows its tooltip chip", async ({ page }) => {
  const btn = page.locator("#versionHistoryBtn");
  await expect(btn).toHaveAttribute("data-tooltip", "Version history");

  const chipOpacity = () => btn.evaluate((el) => getComputedStyle(el, "::after").opacity);

  expect(await chipOpacity()).toBe("0");
  await btn.hover();
  await expect.poll(chipOpacity).toBe("1");
});
