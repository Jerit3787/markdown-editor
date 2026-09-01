import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";

const BASE = "http://localhost:8787";

async function dismissWhatsNew(page: import("@playwright/test").Page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await gotIt.click();
  }
}

async function waitForApp(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
}

test("a shared workspace previews without persisting, and Keep makes it survive a reload", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await signInAsDevUser(alice, "alice-preview-e2e");
  await signInAsDevUser(bob, "bob-preview-e2e");

  // Alice: create and share a single document.
  await alice.goto(BASE);
  await waitForApp(alice);
  await dismissWhatsNew(alice);
  await alice.click("#emptyNewWorkspaceBtn");
  await alice.keyboard.press("Escape").catch(() => {});
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("Shared preview content");

  await alice.click('button:has-text("Share")');
  const moveDialog = alice.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  const accessSelect = alice.locator("select").first();
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    alice.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);
  const shareState = await alice.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  const remoteId = shareState.ws.remoteId as string;
  const shareUrl = `${BASE}/w/${remoteId}/${shareState.activeDoc.id}/edit`;

  // Bob already has a workspace of his own before ever seeing the link —
  // this is what makes the single-doc auto-join land as a preview instead
  // of committing permanently (decideJoinTarget in collab.ts).
  await bob.goto(BASE);
  await waitForApp(bob);
  await dismissWhatsNew(bob);
  await bob.click("#emptyNewWorkspaceBtn");
  await bob.keyboard.press("Escape").catch(() => {});

  await bob.goto(shareUrl);
  await waitForApp(bob);
  await expect.poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("Shared preview content");
  await expect(bob.locator(".workspace-preview-badge")).toBeVisible();

  // The "Preview" badge sits inside the switcher's flex row alongside the
  // workspace name — .workspace-name needs min-width:0 for its own
  // ellipsis to actually kick in, otherwise the whole row (badge included)
  // refuses to shrink below its natural content width and spills past
  // #sidebar's right edge instead of truncating the name.
  const sidebarBox = (await bob.locator("#sidebar").boundingBox())!;
  const triggerBox = (await bob.locator(".workspace-switcher-trigger").boundingBox())!;
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);

  await bob.reload();
  await waitForApp(bob);
  const afterReload = await bob.evaluate(() => JSON.parse(localStorage.getItem("mde:workspaces") || "[]"));
  expect(afterReload.some((w: { remoteId?: string }) => w.remoteId === remoteId)).toBe(false);

  // Re-join, this time click Keep — it must survive a reload.
  await bob.goto(shareUrl);
  await waitForApp(bob);
  await expect(bob.locator(".workspace-preview-badge")).toBeVisible();
  await bob.click(".workspace-switcher-trigger");
  await bob.click('button:has-text("Keep this workspace")');

  await bob.reload();
  await waitForApp(bob);
  const afterKeepReload = await bob.evaluate(() => JSON.parse(localStorage.getItem("mde:workspaces") || "[]"));
  expect(afterKeepReload.some((w: { remoteId?: string }) => w.remoteId === remoteId)).toBe(true);
});
