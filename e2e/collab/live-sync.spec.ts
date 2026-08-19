import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";

const BASE = "http://localhost:8787";

async function dismissWhatsNew(page: import("@playwright/test").Page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await gotIt.click();
  }
}

test("a live edit from one collaborator appears in another's browser with no reload", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await signInAsDevUser(alice, "alice-e2e");
  await signInAsDevUser(bob, "bob-e2e");

  await alice.goto(BASE);
  await alice.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(alice);
  // window.MDE.newDoc() silently no-ops (just a toast) on a truly fresh
  // context with zero workspaces — confirmed live: a Playwright
  // browser.newContext() has no localStorage at all, unlike an
  // already-used browser profile, which is why this differs from
  // two-user-live-sync.mjs's own equivalent comment (that script never
  // hit this because it happened to run against a profile with leftover
  // state). #emptyNewWorkspaceBtn is the real empty-state UI's own
  // "create a workspace" action — the same button a first-time user
  // would click (a dynamic import of the store module, tried first,
  // doesn't work here: the collab project serves wrangler's pre-built
  // client/dist bundle, not raw /src/*.ts files the way vite dev does
  // for the local project).
  await alice.click("#emptyNewWorkspaceBtn");
  // Clicking it also opens the workspace switcher to rename the new
  // workspace — dismiss that before continuing.
  await alice.keyboard.press("Escape").catch(() => {});
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("PLAYWRIGHT E2E content that must sync live to bob");

  await alice.click('button:has-text("Share")');
  const moveDialog = alice.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await moveDialog.click();
  }
  const accessSelect = alice.locator("select").first();
  await accessSelect.waitFor({ state: "visible" });
  // selectOption() only waits for the DOM "change" event to dispatch, not
  // for the async onAccessModeChange handler it triggers — that handler
  // awaits a PUT to /api/workspace/:id/access before writing shared/remoteId
  // to localStorage (see Share.svelte's onAccessModeChange -> collab.ts's
  // setAccessMode). Reading localStorage immediately after selectOption()
  // races that fetch, so wait for the response first.
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
  expect(shareState.ws?.shared).toBe(false);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  const doneBtn = alice.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await alice.keyboard.press("Escape").catch(() => {});

  await bob.goto(shareUrl);
  await bob.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = bob.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await bob.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(bob);

  await expect
    .poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""))
    .toContain("PLAYWRIGHT E2E content");

  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.press("End");
  await alice.keyboard.type(" [LIVE APPEND]");

  await expect
    .poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""))
    .toContain("[LIVE APPEND]");

  await aliceCtx.close();
  await bobCtx.close();
});
