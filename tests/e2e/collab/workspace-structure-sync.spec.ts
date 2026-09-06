import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";
import { readSharedState } from "./support/share";

const BASE = "http://localhost:8787";

async function dismissWhatsNew(page: import("@playwright/test").Page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await gotIt.click();
  }
}

async function createFirstWorkspaceAndDoc(page: import("@playwright/test").Page) {
  await page.click("#emptyNewWorkspaceBtn");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
}

async function shareAsAnyoneWithLink(owner: import("@playwright/test").Page, roleLabel: "Viewer" | "Editor") {
  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  // A workspace that already has more than one document shows a
  // "share just this document, or the whole workspace?" choice instead —
  // this feature is specifically about sharing/joining a whole workspace,
  // so always pick that option when this dialog appears.
  const shareWholeWorkspace = owner.locator('button:has-text("Share whole workspace")');
  if (await shareWholeWorkspace.isVisible({ timeout: 2000 }).catch(() => false)) await shareWholeWorkspace.click();
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
    roleSelect.selectOption({ label: roleLabel }),
  ]);
  await owner.keyboard.press("Escape").catch(() => {});
}

async function joinAsNewWorkspace(viewer: import("@playwright/test").Page, shareUrl: string) {
  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = viewer.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await viewer.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(viewer);
}

test("a shared workspace's real name reaches a fresh joiner and updates live for an already-connected collaborator", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "wsname-owner-e2e");
  await signInAsDevUser(viewer, "wsname-viewer-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("first doc content");
  const firstDocId = await owner.evaluate(() => localStorage.getItem("mde:active"));

  // A second document so the joiner takes the multi-document join path,
  // where the real workspace name (not a single doc's own name) is shown.
  await owner.evaluate(() => window.MDE.newDoc());
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("second doc content");
  await owner.evaluate((id) => window.MDE.switchDoc(id), firstDocId);

  await shareAsAnyoneWithLink(owner, "Editor");

  // A workspace's name isn't pushed to its room automatically the moment
  // it's first shared (the DO's own `name` starts empty, exactly like a
  // workspace shared before this feature shipped, per this feature's own
  // spec) — an explicit rename is what actually populates it. Renaming
  // AFTER sharing (rather than before) is what exercises the real
  // pushWorkspaceRename() path, since it only fires for an
  // already-shared workspace.
  await owner.click(".workspace-switcher-trigger");
  await owner.click('.workspace-row [aria-label="Rename workspace"]');
  const renameInput = owner.locator(".workspace-rename-input");
  await renameInput.fill("Team Docs");
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/meta$/.test(res.url()) && res.request().method() === "PUT"),
    renameInput.press("Enter"),
  ]);
  // The switcher popover only closes on a real click outside it (see its
  // own document-click listener) — Escape doesn't close it, so clicking
  // the trigger again later would just toggle it shut instead of open.
  await owner.click("#editor-mount .cm-content");

  const shareState = await readSharedState(owner, firstDocId);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${firstDocId}/edit`;

  await joinAsNewWorkspace(viewer, shareUrl);

  // The fresh joiner sees the sharer's real workspace name, not the
  // "Shared workspace" placeholder the old, name-less join path showed.
  await expect(viewer.locator(".workspace-switcher-trigger .workspace-name")).toHaveText("Team Docs");

  // Live rename: the owner renames the workspace again while the viewer
  // stays connected — the label updates with no reload.
  await owner.click(".workspace-switcher-trigger");
  await owner.click('.workspace-row [aria-label="Rename workspace"]');
  const renameInput2 = owner.locator(".workspace-rename-input");
  await renameInput2.fill("Renamed Live");
  await renameInput2.press("Enter");
  await owner.keyboard.press("Escape").catch(() => {});

  await expect.poll(() => viewer.locator(".workspace-switcher-trigger .workspace-name").textContent()).toBe("Renamed Live");
});

test("deleting a document from a shared workspace removes it live for other collaborators, landing them somewhere sane if it was their active document", async ({
  browser,
}) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "wsdel-owner-e2e");
  await signInAsDevUser(viewer, "wsdel-viewer-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("first doc");
  const firstDocId = await owner.evaluate(() => localStorage.getItem("mde:active"));

  await owner.evaluate(() => window.MDE.newDoc());
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("second doc");
  const secondDocId = await owner.evaluate(() => localStorage.getItem("mde:active"));
  await owner.evaluate((id) => window.MDE.switchDoc(id), firstDocId);

  await shareAsAnyoneWithLink(owner, "Editor");

  const shareState = await readSharedState(owner, firstDocId);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${firstDocId}/edit`;

  await joinAsNewWorkspace(viewer, shareUrl);
  // Only asserting doc-list membership here, not editor content — a
  // separate, already-known content-sync-timing race (unrelated to this
  // feature) can occasionally leave a just-joined doc's content empty
  // for a moment; this test is about document deletion propagation.
  await expect(viewer.locator("#docList li")).toHaveCount(2);

  // Owner deletes the SECOND document (not the one the viewer has open) —
  // it should vanish from the viewer's sidebar with no reload.
  await owner.evaluate((id) => window.MDE.switchDoc(id), secondDocId);
  await owner.click('#docList li.active [aria-label="Document options"]');
  await owner.click(".doc-menu-popover button.danger");
  await owner.click(".primary-btn.danger");

  await expect(viewer.locator("#docList li")).toHaveCount(1);

  // Owner now deletes the FIRST document — the one the viewer currently
  // has open — the viewer must land somewhere sane instead of a
  // broken/blank editor.
  await owner.click('#docList li.active [aria-label="Document options"]');
  await owner.click(".doc-menu-popover button.danger");
  await owner.click(".primary-btn.danger");

  await expect(viewer.locator("#docList li")).toHaveCount(0);
  await expect(viewer.locator("#emptyState")).toBeVisible();
});
