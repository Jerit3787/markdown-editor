import { test, expect } from "./support/fixtures";

test("EDIT-17: switching documents with the view mode locked (no .view-selector) does not throw", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForTimeout(100);
  const secondId = await page.evaluate(() => localStorage.getItem("mde:active"));

  // Lock the view — Toolbar.svelte then stops rendering .view-selector,
  // and app.ts's updateMainView() must not blow up trying to style an
  // element that isn't there (regression for 0c658b6).
  await page.evaluate(async () => {
    const { viewModeLocked, setView } = await import("/src/stores/view.ts");
    setView("preview");
    viewModeLocked.set(true);
  });
  await expect(page.locator(".view-selector")).toHaveCount(0);

  const docs = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { id: string }) => d.id));
  await page.evaluate((id) => window.MDE.switchDoc(id), docs[0]);
  await page.evaluate((id) => window.MDE.switchDoc(id), secondId);
  await page.evaluate((id) => window.MDE.switchDoc(id), docs[0]);

  await page.waitForTimeout(200);
  expect(errors).toEqual([]);
  await expect(page.locator("#preview")).toBeVisible();
});

test("MOB-11: the workspace switcher's Preview badge stays within the sidebar's right edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.evaluate(async () => {
    const ws = await import("/src/stores/workspaces.ts");
    ws.workspacesStore.update((all) => all.map((w, i) => (i === 0 ? { ...w, name: "A fairly long workspace name here", ephemeral: true } : w)));
  });

  await page.click("#sidebarToggleOut"); // open the sidebar sheet
  const badge = page.locator(".workspace-preview-badge");
  await expect(badge).toBeVisible();

  const badgeBox = (await badge.boundingBox())!;
  const sidebarBox = (await page.locator("#sidebar").boundingBox())!;
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1);
});
