import { test, expect } from "../local/support/fixtures";

// MOB-12 — the Share dialog's general-access <select> must reserve room
// for its dropdown arrow beyond the raw label width, on a
// mobile-Safari-width viewport, so the arrow doesn't overlap "Anyone with
// the link" / the longer "Anyone with an account". Share.svelte sizes the
// <select> in JS as `mirror text width + 32px`; the original bug was a
// 22px reserve that iOS Safari's wider arrow affordance clipped.
//
// Runs in the `webkit` Playwright project at an iPhone viewport (see
// playwright.config.ts). This is WebKit-the-engine, not
// iOS-Safari-the-platform — native <select> chrome is host-OS-level — so
// it guards the width-computation logic + CSS + the no-horizontal-overflow
// invariant under WebKit, not the exact iOS arrow pixel width.

const ARROW_RESERVE_MIN = 24; // prod reserves 32; allow box-model slack, but well above the old buggy 22

async function openShareWithAccess(page: import("@playwright/test").Page, requireAccount: boolean) {
  await page.evaluate(
    async ({ requireAccount }) => {
      const { shareModalOpen, shareAccess } = await import("/src/stores/share.ts");
      shareAccess.set({ owner: null, generalAccess: "anyone", requireAccount, role: "editor", invited: [] });
      shareModalOpen.set(true);
    },
    { requireAccount },
  );
  await page.waitForSelector('select[aria-label="General access"]', { state: "visible" });
  // let Share.svelte's width $effect run against the mirror
  await page.waitForTimeout(100);
}

async function expectArrowRoomAndNoOverflow(page: import("@playwright/test").Page, expectedLabel: string, expectedValue: string) {
  const select = page.locator('select[aria-label="General access"]');
  await expect(select).toHaveValue(expectedValue);
  expect((await select.evaluate((el: HTMLSelectElement) => el.options[el.selectedIndex]!.text)).trim()).toBe(expectedLabel);

  const m = await page.evaluate(() => {
    const sel = document.querySelector('select[aria-label="General access"]') as HTMLSelectElement;
    const mir = document.querySelector(".share-access-mirror") as HTMLElement;
    return {
      selectW: sel.getBoundingClientRect().width,
      mirrorW: mir.getBoundingClientRect().width,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  // The control is wider than the bare label text — room for the arrow.
  expect(m.selectW - m.mirrorW).toBeGreaterThanOrEqual(ARROW_RESERVE_MIN);
  // Nothing pushes the page wider than the phone.
  expect(m.docOverflow).toBe(false);
}

test("MOB-12: the 'Anyone with the link' access select reserves arrow room at mobile-Safari width", async ({ page }) => {
  await openShareWithAccess(page, false);
  await expectArrowRoomAndNoOverflow(page, "Anyone with the link", "anyone-link");
});

test("MOB-12: the longer 'Anyone with an account' access select reserves arrow room at mobile-Safari width", async ({ page }) => {
  await openShareWithAccess(page, true);
  await expectArrowRoomAndNoOverflow(page, "Anyone with an account", "anyone-account");
});
