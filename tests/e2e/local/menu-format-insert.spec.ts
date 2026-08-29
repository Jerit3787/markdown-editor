import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function setContentAndSelectAll(page: Page, content: string) {
  await page.evaluate((content) => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0, head: content.length } });
    view.focus();
  }, content);
}

test("Format menu applies Bold/Italic/Strikethrough to the selection", async ({ page }) => {
  await setContentAndSelectAll(page, "hello");
  await page.click("#formatMenuBtn");
  await page.click("#menuBold");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("**hello**");

  await setContentAndSelectAll(page, "hello");
  await page.click("#formatMenuBtn");
  await page.click("#menuItalic");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("_hello_");

  await setContentAndSelectAll(page, "hello");
  await page.click("#formatMenuBtn");
  await page.click("#menuStrike");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("~~hello~~");
});

test("Insert menu opens the link modal with the selection prefilled", async ({ page }) => {
  await setContentAndSelectAll(page, "hello");
  await page.click("#insertMenuBtn");
  await page.click("#menuLink");
  const urlInput = page.locator('input[placeholder*="https://" i], input[type="url"]').first();
  await expect(urlInput).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Edit menu no longer contains the moved Format/Insert buttons", async ({ page }) => {
  expect(await page.locator("#editMenu #menuBold").count()).toBe(0);
  expect(await page.locator("#editMenu #menuLink").count()).toBe(0);
  expect(await page.locator("#formatMenu #menuBold").count()).toBe(1);
  expect(await page.locator("#insertMenu #menuLink").count()).toBe(1);
});
