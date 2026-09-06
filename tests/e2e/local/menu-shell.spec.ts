import { test, expect } from "./support/fixtures";

// SHELL-18 — every menu opens and closes, and click-outside closes an
// open menu. (Format / Insert / View are covered elsewhere; this covers
// File / Edit / Help.)
for (const [btn, menu] of [
  ["#fileMenuBtn", "#fileMenu"],
  ["#editMenuBtn", "#editMenu"],
  ["#helpMenuBtn", "#helpMenu"],
] as const) {
  test(`SHELL-18: ${menu} opens on its button and closes on click-outside`, async ({ page }) => {
    await page.click(btn);
    await expect(page.locator(menu)).toBeVisible();
    await page.mouse.click(5, 300); // click well outside any menu
    await expect(page.locator(menu)).toBeHidden();
  });
}

test("SHELL-18: hovering a second menu button while one is open switches to it", async ({ page }) => {
  await page.click("#fileMenuBtn");
  await expect(page.locator("#fileMenu")).toBeVisible();
  await page.hover("#helpMenuBtn");
  await expect(page.locator("#helpMenu")).toBeVisible();
  await expect(page.locator("#fileMenu")).toBeHidden();
});

// SHELL-20 — the Help-menu modals each open and close.
test("SHELL-20: Help → Keyboard Shortcuts opens and closes the shortcuts modal", async ({ page }) => {
  await page.click("#helpMenuBtn");
  await page.click("#menuShortcuts");
  await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeHidden();
});

test("SHELL-20: Help → About & Privacy opens and closes the About modal", async ({ page }) => {
  await page.click("#helpMenuBtn");
  await page.click("#menuInfo");
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "About" })).toBeHidden();
});
