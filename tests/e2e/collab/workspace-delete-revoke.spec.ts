import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace } from "./support/collab";

// F4: deleting a shared workspace as its owner hard-revokes remote access.
test("owner deleting a shared workspace revokes it for a connected collaborator", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "del-owner-e2e", "shared body");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expect.poll(() => b.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("shared body");

  // Owner deletes the workspace from the switcher.
  await a.click("#workspace-switcher-mount .workspace-switcher-trigger");
  await a.click('#workspace-switcher-mount .workspace-row button[aria-label="Delete workspace"]');
  // ConfirmDialog — owner copy, then the danger confirm button.
  await expect(a.locator("text=revokes access for everyone")).toBeVisible();
  await a.locator('.modal-box-v2 button.primary-btn:has-text("Delete")').click();

  // Collaborator: the "deleted by its owner" banner appears and the
  // workspace is gone from their sidebar.
  await expect(b.locator(".workspace-access-banner")).toContainText("deleted by its owner", { timeout: 20000 });

  // Re-opening the link now lands straight on the deleted banner.
  await b.goto(url);
  await expect(b.locator(".workspace-access-banner")).toContainText("deleted by its owner", { timeout: 20000 });

  await aCtx.close();
  await bCtx.close();
});
