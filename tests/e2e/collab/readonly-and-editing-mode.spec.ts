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
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("plus a collab edit");
  await page.evaluate(() => window.MDE.undo());
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).not.toContain("plus a collab edit");
  await page.evaluate(() => window.MDE.redo());
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("plus a collab edit");
});

test("a viewer-access room locks the app to Preview-only, and editable access allows typing", async ({ browser }) => {
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
  // Unlike the "Anyone with the link" flow above (which has its own "Done"
  // button check further down), this test never closes the Share modal —
  // its backdrop was left blocking every later click on the owner's page,
  // including the second-document click much further below.
  await owner.keyboard.press("Escape").catch(() => {});

  const firstDocId = await owner.evaluate(() => localStorage.getItem("mde:active"));

  // Create the second document now, before the viewer ever joins, rather
  // than after — a viewer's own initial join (fetchWorkspaceDocIds, see
  // collab.ts's joinSharedLink) picks up every document the workspace
  // room already knows about at that moment, but there's no mechanism
  // for an *already*-connected client to discover one introduced later
  // (no server push, no polling) — a separate, larger gap than this test
  // is about. Creating it up front sidesteps that gap while still fully
  // exercising the actual regression below: a locked viewer switching
  // between two documents it already has.
  await owner.evaluate(() => window.MDE.newDoc());
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("second document content");
  const secondDocId = await owner.evaluate(() => localStorage.getItem("mde:active"));
  expect(secondDocId).not.toBe(firstDocId);
  await owner.evaluate((id) => window.MDE.switchDoc(id), firstDocId);

  const shareState = await owner.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  expect(shareState.ws?.shared).toBe(true);
  expect(shareState.activeDoc.id).toBe(firstDocId);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = viewer.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await viewer.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(viewer);

  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("owner-authored content");

  // Read-only: CodeMirror's readOnly facet blocks dispatched changes.
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor().state.readOnly)).toBe(true);

  // A viewer isn't merely read-only — the app locks into Preview-only view
  // mode for the whole session, so there's no editor surface to even click
  // into. #editor-mount is hidden (display:none via #body.mode-preview),
  // not just disabled, and the Editor/Split toolbar control disappears
  // entirely (see stores/view.ts's viewModeLocked).
  await expect(viewer.locator("#editor-mount")).toBeHidden();
  await expect(viewer.locator("#preview")).toBeVisible();
  await expect(viewer.locator(".view-selector")).toHaveCount(0);

  const beforeAttempt = await viewer.evaluate(() => window.MDE.getEditor().state.doc.toString());
  await viewer.keyboard.type("this should not appear");
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe(beforeAttempt);

  // Regression: app.ts's updateMainView() runs on every doc switch and
  // used to unconditionally set .style.display on .view-selector — an
  // element Toolbar.svelte only renders while view mode isn't locked (see
  // the .toHaveCount(0) assertion above). A locked viewer switching to a
  // second document threw straight out of that update, aborting whatever
  // else was queued in the same reactive pass. The second document
  // (created above, before the viewer joined) is already part of the
  // viewer's own initial join — switching to it here is the exact repro.
  const pageErrors: string[] = [];
  viewer.on("pageerror", (err) => pageErrors.push(err.message));

  await expect
    .poll(() => viewer.evaluate((id) => JSON.parse(localStorage.getItem("mde:docs") || "[]").some((d: { id: string }) => d.id === id), secondDocId))
    .toBe(true);
  await viewer.evaluate((id) => window.MDE.switchDoc(id), secondDocId);
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("second document content");

  // The crash aborted this same update, so re-verifying it here would
  // otherwise silently pass on stale state — the pageerror check above is
  // what actually catches the regression.
  await expect(viewer.locator("#editor-mount")).toBeHidden();
  await expect(viewer.locator("#preview")).toBeVisible();
  await expect(viewer.locator(".view-selector")).toHaveCount(0);
  expect(pageErrors).toEqual([]);

  await ownerCtx.close();
  await viewerCtx.close();
});

test("a viewer with no session at all sees the signed-out indicator and can sign in from it", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "sig-owner-e2e");
  // Deliberately no signInAsDevUser(viewer, ...) — this viewer has no
  // session at all, the exact case isIdentityUnverified() flags.

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("owner-authored content");

  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  const accessSelect = owner.locator('select[aria-label="General access"]');
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);

  const shareState = await owner.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = viewer.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await viewer.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(viewer);

  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("owner-authored content");

  const indicator = viewer.locator('button.signed-out-indicator:has-text("Signed out")');
  await expect(indicator).toBeVisible();

  await indicator.click();
  await expect(viewer.locator('text="Sign in required"')).toBeVisible();

  await ownerCtx.close();
  await viewerCtx.close();
});
