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
  expect(shareState.ws?.shared).toBe(true);
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

  await expect.poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("PLAYWRIGHT E2E content");

  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.press("End");
  await alice.keyboard.type(" [LIVE APPEND]");

  await expect.poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("[LIVE APPEND]");

  await aliceCtx.close();
  await bobCtx.close();
});

test("reloading a shared document does not duplicate its content", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await signInAsDevUser(page, "refresh-dup-e2e");

  await page.goto(BASE);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(page);
  await page.click("#emptyNewWorkspaceBtn");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await page.click("#editor-mount .cm-content");
  const marker = "REFRESH-DUP-MARKER";
  await page.keyboard.type(marker);

  await page.click('button:has-text("Share")');
  const moveDialog = page.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await moveDialog.click();
  }
  const accessSelect = page.locator("select").first();
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);
  const doneBtn = page.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await page.keyboard.press("Escape").catch(() => {});

  // Give the initial share sync a moment to actually round-trip to the
  // server — refreshing before that reply lands is exactly the race this
  // test is meant to catch (see collab.ts's markDocSynced/whenSynced).
  await page.waitForTimeout(1500);

  // Reload three times, same as a user hitting refresh repeatedly on a
  // live document tab. Each reload re-triggers the client's rejoin path
  // (joinSharedLink -> joinWorkspace -> bindActiveDoc) while the editor
  // already shows the document's last-known content locally — if
  // bindActiveDoc attaches the collaborative editing extension before
  // the server's own sync reply lands, that reply gets forwarded into
  // the already-populated editor as a second, indistinguishable copy.
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
    await dismissWhatsNew(page);
    // No fixed condition to poll for "sync settled" from outside the
    // app — wait long enough for the join/sync round trip to complete,
    // matching the window the underlying race actually occurs in.
    await page.waitForTimeout(2000);
    const content = await page.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "");
    expect(content.split(marker).length - 1, `after reload #${i + 1}, content was: ${JSON.stringify(content)}`).toBe(1);
  }

  await ctx.close();
});

test("a document created after both collaborators are already connected appears in the other's document list live", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await signInAsDevUser(alice, "alice-e2e-2");
  await signInAsDevUser(bob, "bob-e2e-2");

  await alice.goto(BASE);
  await alice.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(alice);
  await alice.click("#emptyNewWorkspaceBtn");
  await alice.keyboard.press("Escape").catch(() => {});
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("first document content");

  await alice.click('button:has-text("Share")');
  const moveDialog = alice.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await moveDialog.click();
  }
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
  expect(shareState.ws?.shared).toBe(true);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  const doneBtn = alice.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await alice.keyboard.press("Escape").catch(() => {});

  // Bob joins and fully settles on the first document BEFORE Alice ever
  // creates the second one — unlike an existing regression test
  // (readonly-and-editing-mode.spec.ts) whose second document is created
  // before its viewer ever joins, which already worked via joinWorkspace's
  // own fetchWorkspaceDocIds picking it up at join time. This test is
  // specifically the mid-session case that gap didn't cover.
  await bob.goto(shareUrl);
  await bob.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = bob.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await bob.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(bob);
  await expect.poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("first document content");

  // Only now, after Bob is fully connected and settled on the first
  // document, does Alice create a second one in the same workspace.
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("second document content, created mid-session");

  const secondDocId = await alice.evaluate(() => localStorage.getItem("mde:active"));

  await expect
    .poll(() =>
      bob.evaluate((id) => JSON.parse(localStorage.getItem("mde:docs") || "[]").some((d: { id: string }) => d.id === id), secondDocId),
    )
    .toBe(true);

  await bob.evaluate((id) => window.MDE.switchDoc(id), secondDocId);
  await expect
    .poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""))
    .toContain("second document content, created mid-session");

  await aliceCtx.close();
  await bobCtx.close();
});
