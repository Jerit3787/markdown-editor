import { test, expect } from "./support/fixtures";

async function typeSomeContent(page: import("@playwright/test").Page) {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("# Hello\n\nSome content.");
  await expect(page.locator("#preview")).toContainText("Hello");
}

test("print media hides all app chrome and shows the preview, regardless of view mode", async ({ page }) => {
  await typeSomeContent(page);

  // Split view (default)
  await expect(page.locator("#body")).toHaveClass(/mode-split/);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#topbar")).not.toBeVisible();
  await expect(page.locator("#sidebar")).not.toBeVisible();
  await expect(page.locator("#editorPane")).not.toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
  await page.emulateMedia({ media: null });

  // Editor-only view
  await page.click('.view-selector button[title="Toggle preview pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#editorPane")).not.toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
  await page.emulateMedia({ media: null });
  await page.click('.view-selector button[title="Toggle preview pane"]');

  // Preview-only view
  await page.click('.view-selector button[title="Toggle editor pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-preview/);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#editorPane")).not.toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
});

test("the printed page shows the document title as a heading, hidden on screen", async ({ page }) => {
  await typeSomeContent(page);

  await expect(page.locator("#printDocTitle")).not.toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#printDocTitle")).toBeVisible();
  await expect(page.locator("#printDocTitle")).toHaveText("E2E Test Doc");
});
