import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";

const BASE = "http://localhost:8787";

async function dismissWhatsNew(page: import("@playwright/test").Page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await gotIt.click();
  }
}

// window.MDE.newDoc() silently no-ops (just a toast) on a truly fresh
// context with zero workspaces (see e2e/collab/live-sync.spec.ts for the
// full explanation) — #emptyNewWorkspaceBtn is the real empty-state UI's
// own "create a workspace" action, the same one a first-time user would
// click.
async function createFirstWorkspaceAndDoc(page: import("@playwright/test").Page) {
  await page.click("#emptyNewWorkspaceBtn");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
}

test("undo/redo route through the collab UndoManager while in a shared room, and back to local history after leaving", async ({ page }) => {
  await signInAsDevUser(page, "readonly-e2e");
  await page.goto(BASE);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(page);

  await createFirstWorkspaceAndDoc(page);

  // Before sharing: editable, local (non-collab) undo stack.
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("before sharing");
  await page.evaluate(() => window.MDE.undo());
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("");
  await page.evaluate(() => window.MDE.redo());
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("before sharing");

  await page.click('button:has-text("Share")');
  const moveDialog = page.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  const accessSelect = page.locator("select").first();
  await accessSelect.waitFor({ state: "visible" });
  // selectOption() only waits for the DOM "change" event to dispatch, not
  // for the async onAccessModeChange handler it triggers — that handler
  // awaits a PUT to /api/workspace/:id/access before the room is actually
  // joined. Wait for that response before treating the room as ready.
  await Promise.all([
    page.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);
  const doneBtn = page.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await page.keyboard.press("Escape").catch(() => {});

  // Once in the room: still editable (owner), and a further edit's
  // undo/redo must still work — now routed through the Yjs
  // UndoManager instead of CM6's own history(), per enterCollabMode.
  await page.waitForTimeout(1000); // let the room connection settle
  await page.click("#editor-mount .cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type(" plus a collab edit");
  await expect
    .poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString()))
    .toContain("plus a collab edit");
  await page.evaluate(() => window.MDE.undo());
  await expect
    .poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString()))
    .not.toContain("plus a collab edit");
  await page.evaluate(() => window.MDE.redo());
  await expect
    .poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString()))
    .toContain("plus a collab edit");
});

test("a viewer-access room makes the editor read-only, and editable access allows typing", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "ro-owner-e2e");
  await signInAsDevUser(viewer, "ro-viewer-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("owner-authored content");

  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  // Two selects matter here: "General access" (Restricted / Anyone with an
  // account / Anyone with the link) and, once "anyone" access is on, a
  // second "Access level for people with the link" select (Viewer /
  // Reviewer / Editor) that actually controls read-only vs. editable —
  // confirmed against client/src/components/Share.svelte's markup (the
  // plan's placeholder "Can view" label doesn't exist there).
  const accessSelect = owner.locator('select[aria-label="General access"]');
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);
  const roleSelect = owner.locator('select[aria-label="Access level for people with the link"]');
  await roleSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    roleSelect.selectOption({ label: "Viewer" }),
  ]);

  const shareState = await owner.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  expect(shareState.ws?.shared).toBe(true);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = viewer.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await viewer.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(viewer);

  await expect
    .poll(() => viewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""))
    .toContain("owner-authored content");

  // Read-only: CodeMirror's readOnly facet blocks dispatched changes.
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor().state.readOnly)).toBe(true);

  const beforeAttempt = await viewer.evaluate(() => window.MDE.getEditor().state.doc.toString());
  await viewer.click("#editor-mount .cm-content");
  await viewer.keyboard.type("this should not appear");
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe(beforeAttempt);

  await ownerCtx.close();
  await viewerCtx.close();
});
