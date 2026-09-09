import { test, expect } from "./support/fixtures";

test("UI-1: top-bar icon buttons are circular", async ({ page }) => {
  const radius = (sel: string) =>
    page.locator(sel).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { br: parseFloat(cs.borderRadius), w: el.getBoundingClientRect().width };
    });

  const vh = await radius("#versionHistoryBtn");
  expect(vh.br).toBeGreaterThanOrEqual(vh.w * 0.4); // ~50% → half the box

  const comments = await radius("#commentsBtn");
  expect(comments.br).toBeGreaterThanOrEqual(comments.w * 0.4);

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

test("v2: the account button opens a menu with Settings + Sign in (signed out)", async ({ page }) => {
  const btn = page.locator("#topbar-account-mount .topbar-account-btn");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("data-tooltip", "Account");
  expect(await btn.locator('use[href="#icon-user"]').count()).toBe(1);

  // Signed out — no avatar, so the button carries a circle outline.
  const border = await btn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth), radius: s.borderTopLeftRadius };
  });
  expect(border.style).toBe("solid");
  expect(border.width).toBeGreaterThanOrEqual(1);
  expect(border.radius === "50%" || parseFloat(border.radius) >= 19).toBe(true);

  await btn.click();
  await expect(page.locator('.topbar-account-menu [role="menuitem"]:has-text("Sign in with GitHub")')).toBeVisible();
  await expect(page.locator('.topbar-account-menu [role="menuitem"]:has-text("Settings")')).toBeVisible();
});

test("v2: Settings no longer has a GitHub row — auth lives in the account menu", async ({ page }) => {
  await page.locator("#topbar-account-mount .topbar-account-btn").click();
  await page.locator('.topbar-account-menu [role="menuitem"]:has-text("Settings")').click();
  const modal = page.locator('[aria-labelledby="settingsModalTitle"]');
  await expect(modal).toBeVisible();
  await expect(modal.locator(".setting-title", { hasText: /^GitHub$/ })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: /^Sign in$/ })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: /^Disconnect$/ })).toHaveCount(0);
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

test("v2: the mode-switcher caret is not rotated on a phone-width viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await enterCollabRoom(page);
  const transform = await page.locator(".mode-switcher-caret").evaluate((el) => getComputedStyle(el).transform);
  // "none" or an identity matrix — a rotate(90deg) would be matrix(0,1,-1,0,0,0).
  expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(transform);
});

test("v2: the mode-switcher button is an outlined pill", async ({ page }) => {
  await enterCollabRoom(page);
  const cs = await page.locator(".mode-switcher-btn").evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth) };
  });
  expect(cs.style).toBe("solid");
  expect(cs.width).toBeGreaterThanOrEqual(1);
});

test("v2: the account avatar is a 32px image inset in the 40px button", async ({ page }) => {
  const pad = await page.locator("#topbar-account-mount .topbar-account-btn").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(pad).toBeGreaterThanOrEqual(3);

  await page.evaluate(async () => {
    const g = await import("/src/stores/github.ts");
    g.githubUsername.set("octocat");
  });
  const w = await page.locator("#topbar-account-mount img.topbar-account-avatar").evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeLessThanOrEqual(34);

  // Signed in — the avatar gives the edge, so the circle outline is dropped.
  const borderWidth = await page.locator("#topbar-account-mount .topbar-account-btn").evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
  expect(borderWidth).toBe(0);
});
