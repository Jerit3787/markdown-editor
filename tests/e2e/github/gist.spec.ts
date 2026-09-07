import { test, expect, type Page } from "@playwright/test";
import { GIST_ID, USERNAME, signInReal, readDocs } from "./support/github";

// GIST-11 — opening a Gist (own list / pasted URL / pasted id) creates a
// new local document. Drives the real /api/gists + /api/gist/:id proxy
// endpoints against the fixture gist (see tests/e2e/github/README.md).

async function expectHandbookOpened(page: Page) {
  await expect(page.locator("#editor-mount .cm-content")).toContainText("# Fixture Handbook", { timeout: 15000 });
  await expect.poll(async () => (await readDocs(page)).some((d) => d.name === "handbook" && d.gistId === GIST_ID), { timeout: 10000 }).toBe(true);
}

test("GIST-11: opening a gist from the account's list creates a local document", async ({ page }) => {
  await signInReal(page);
  await page.click("#emptyNewWorkspaceBtn"); // openGistPicker needs a workspace
  await page.evaluate(() => window.MDE.openGistPicker?.());
  await expect(page.locator("#openGistModalTitle")).toBeVisible();

  // Prefer a row whose display name mentions the fixture; fall back to the
  // first (and, on a fresh throwaway account, only) markdown gist.
  const named = page.locator(".gist-item", { hasText: "Fixture Handbook" });
  const row = (await named.count()) > 0 ? named.first() : page.locator(".gist-item").first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.getByRole("button", { name: /Open/ }).click();

  await expectHandbookOpened(page);
});

test("GIST-11: opening a gist by pasted URL creates a local document", async ({ page }) => {
  await signInReal(page);
  await page.click("#emptyNewWorkspaceBtn"); // openGistPicker needs a workspace
  await page.evaluate(() => window.MDE.openGistPicker?.());
  await page.fill('input[aria-label="Gist URL or ID"]', `https://gist.github.com/${USERNAME}/${GIST_ID}`);
  await page.locator(".share-row button.secondary-btn", { hasText: "Open" }).click();
  await expectHandbookOpened(page);
});

test("GIST-11: opening a gist by pasted bare id creates a local document", async ({ page }) => {
  await signInReal(page);
  await page.click("#emptyNewWorkspaceBtn"); // openGistPicker needs a workspace
  await page.evaluate(() => window.MDE.openGistPicker?.());
  await page.fill('input[aria-label="Gist URL or ID"]', GIST_ID);
  await page.locator(".share-row button.secondary-btn", { hasText: "Open" }).click();
  await expectHandbookOpened(page);
});
