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

test("UI-2: signed-out account button shows a person icon and a 'Sign in' tooltip", async ({ page }) => {
  const btn = page.locator("#topbar-account-mount .topbar-account-btn");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("data-tooltip", "Sign in");
  await expect(btn).toHaveAttribute("aria-label", "Sign in with GitHub");
  expect(await btn.locator('use[href="#icon-user"]').count()).toBe(1);
});

// The mode switcher only renders inside a collab room — seed one via the
// store (no real connection needed; it just gates the {#if} and the mode).
async function enterCollabRoom(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const m = await import("/src/stores/collabMode.ts");
    m.enterCollabRoom("tcv2-e2e", "editor", true);
  });
  await page.locator(".mode-switcher-btn").waitFor();
}

test("v2: mode-switcher dropdown lays the icon beside the two-line text", async ({ page }) => {
  await enterCollabRoom(page);
  await page.click(".mode-switcher-btn");

  const geom = await page
    .locator(".mode-switcher-item")
    .first()
    .evaluate((item) => {
      const icon = item.querySelector(".icon") as HTMLElement;
      const text = item.querySelector(".mode-switcher-item-text") as HTMLElement;
      return {
        display: getComputedStyle(item).display,
        sameRow: Math.abs(icon.getBoundingClientRect().top - text.getBoundingClientRect().top) < 8,
      };
    });
  expect(geom.display).toBe("flex");
  expect(geom.sameRow).toBe(true);
});
