import { test, expect } from "@playwright/test";

test.describe("Dedicated Marketing Homepage (/home)", () => {
  test("loads with 200 OK, exact brand title, and hero heading", async ({ page }) => {
    const res = await page.goto("/home");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/Markdown Editor/);
    await expect(page.locator("h1")).toHaveText("Markdown Editor");
    await expect(page.locator(".brand span")).toHaveText("Markdown Editor");
  });

  test("hero and header CTA buttons link directly to the editor (/)", async ({ page }) => {
    await page.goto("/home");
    await expect(page.locator("#topLaunchBtn")).toHaveAttribute("href", "/");
    await expect(page.locator("#heroLaunchBtn")).toHaveAttribute("href", "/");

    await page.click("#heroLaunchBtn");
    await expect(page).toHaveURL(/\/(#.*)?$/);
  });

  test("displays all 6 core feature cards and the editor mockup", async ({ page }) => {
    await page.goto("/home");
    await expect(page.locator(".mockup-window")).toBeVisible();
    await expect(page.locator("#features")).toBeVisible();
    await expect(page.locator(".feature-card")).toHaveCount(6);

    const featureHeadings = page.locator(".feature-card h3");
    await expect(featureHeadings.nth(0)).toContainText("Live Preview");
    await expect(featureHeadings.nth(1)).toContainText("100% In-Browser Privacy");
    await expect(featureHeadings.nth(2)).toContainText("Google Drive Integration");
    await expect(featureHeadings.nth(3)).toContainText("GitHub & Gist Sync");
    await expect(featureHeadings.nth(4)).toContainText("Real-Time Collaboration");
    await expect(featureHeadings.nth(5)).toContainText("Flexible Export Options");
  });

  test("displays Google Drive & Data Safety transparency disclosures", async ({ page }) => {
    await page.goto("/home");
    const driveSection = page.locator("#google-drive");
    await expect(driveSection).toBeVisible();
    await expect(driveSection).toContainText("https://www.googleapis.com/auth/drive.file");
    await expect(driveSection).toContainText("AES-256-GCM");
    await expect(driveSection).toContainText("Google Picker");
    await expect(driveSection).toContainText("No copy of your document is ever stored on our servers");
  });

  test("links to Privacy Policy, Terms of Service, and GitHub in nav and footer", async ({ page }) => {
    await page.goto("/home");
    await expect(page.locator('.navbar a[href="/privacy"]')).toBeVisible();
    await expect(page.locator('.navbar a[href="/terms"]')).toBeVisible();
    await expect(page.locator('.footer a[href="/privacy"]')).toBeVisible();
    await expect(page.locator('.footer a[href="/terms"]')).toBeVisible();
    await expect(page.locator('.footer a[href="https://github.com/Jerit3787/markdown-editor"]')).toBeVisible();
  });
});
