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
  await expect(b.locator("#commentsBtn")).toBeDisabled(); // greyed, not hidden (CV2-1b)
  await expect(b.locator("#versionHistoryBtn")).toBeDisabled(); // editing-mode tool (CV2-3)
  await expect(b.locator("#shareBtn")).toBeDisabled(); // an editor-in-Viewing → hard-disabled (CV2-2)
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
  await expect(b.locator("#commentsBtn")).toBeEnabled();
  await expect(b.locator("#versionHistoryBtn")).toBeEnabled();
  await expect(b.locator("#shareBtn")).toBeEnabled();
  await expect(b.locator("#viewingSidebarBtn")).toBeHidden();

  // Suggesting keeps the menus but greys version history (editing-mode tool).
  await b.click(".mode-switcher-btn");
  await b.click('.mode-switcher-menu [role="menuitem"]:has-text("Suggesting")');
  await expect(b.locator("#formatMenuBtn")).toBeVisible();
  await expect(b.locator("#commentsBtn")).toBeEnabled();
  await expect(b.locator("#versionHistoryBtn")).toBeDisabled();
  await expect(b.locator("#shareBtn")).toBeEnabled(); // an editor keeps Share in Suggesting

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

  // CV2 — a viewer's chrome: Edit menu opens condensed (Find/Copy present,
  // Undo hidden); version history + share greyed.
  await b.click("#editMenuBtn");
  await expect(b.locator("#menuFind")).toBeVisible();
  await expect(b.locator("#menuCopy")).toBeVisible();
  await expect(b.locator("#menuUndo")).toBeHidden();
  await b.keyboard.press("Escape");
  await expect(b.locator("#versionHistoryBtn")).toBeDisabled();
  // A viewer's Share button is greyed but still clickable — it's their
  // "Request edit access" entry point (CV2-5).
  await expect(b.locator("#shareBtn")).toHaveClass(/is-muted/);
  await expect(b.locator("#shareBtn")).toBeEnabled();

  await aCtx.close();
  await bCtx.close();
});

test("a non-owner editor collaborator has no Publish / GitHub Repo in the File menu", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "gate-owner-e2e", "body");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);

  await b.click("#fileMenuBtn");
  await expect(b.locator("#publishSubmenu")).toBeHidden();
  await expect(b.locator("#menuPublishSignedOut")).toBeHidden();
  await expect(b.locator('#fileMenu .menu-submenu-trigger:has-text("GitHub Repo")')).toBeHidden();

  // The owner still has them.
  await a.click("#fileMenuBtn");
  await expect(a.locator("#publishSubmenu")).toBeVisible();

  await aCtx.close();
  await bCtx.close();
});
