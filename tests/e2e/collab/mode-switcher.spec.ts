import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace } from "./support/collab";

// D6 + A3 + A4 + C1: a collaborator picks a mode below their role and the
// chrome follows.
test("a collaborator switches Editing → Viewing and the chrome follows", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "mode-owner-e2e", "the shared body");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expect.poll(() => b.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("the shared body");

  // Editing — Format menu + editor pane present.
  await expect(b.locator("#formatMenuBtn")).toBeVisible();
  await expect(b.locator("#editorPane")).toBeVisible();

  // Switch to Viewing.
  await b.click(".mode-switcher-btn");
  await b.click('.mode-switcher-menu [role="menuitem"]:has-text("Viewing")');

  await expect(b.locator("#formatMenuBtn")).toBeHidden();
  await expect(b.locator("#commentsBtn")).toBeHidden();
  await expect(b.locator("#body.mode-preview")).toBeVisible(); // editor pane gone

  // Collapse the sidebar → the floating button appears.
  await b.click("#sidebarToggleIn").catch(() => {});
  await expect(b.locator("#viewingSidebarBtn")).toBeVisible();
  await b.click("#viewingSidebarBtn");
  await expect(b.locator("#viewingSidebarBtn")).toBeHidden();

  // Back to Editing — everything returns.
  await b.click(".mode-switcher-btn");
  await b.click('.mode-switcher-menu [role="menuitem"]:has-text("Editing")');
  await expect(b.locator("#formatMenuBtn")).toBeVisible();
  await expect(b.locator("#commentsBtn")).toBeVisible();
  await expect(b.locator("#viewingSidebarBtn")).toBeHidden();

  await aCtx.close();
  await bCtx.close();
});

test("a viewer-role link only offers Viewing", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "mode-viewer-e2e", "body text");
  const url = await shareAnyoneLink(a, "Viewer");
  await joinSharedWorkspace(b, url);

  await expect(b.locator(".mode-switcher-btn")).toContainText("Viewing");
  await b.click(".mode-switcher-btn");
  await expect(b.locator(".mode-switcher-menu")).toHaveCount(0); // inert for a single option

  await aCtx.close();
  await bCtx.close();
});
