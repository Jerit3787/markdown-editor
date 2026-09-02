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
// context with zero workspaces — #emptyNewWorkspaceBtn is the real
// empty-state UI's own "create a workspace" action.
async function createFirstWorkspaceAndDoc(page: import("@playwright/test").Page) {
  await page.click("#emptyNewWorkspaceBtn");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
}

// Renames the currently-active document via the toolbar title field —
// the same commit path (blur/Enter) the cascade hooks into.
async function renameActiveDoc(page: import("@playwright/test").Page, name: string) {
  await page.click("#docTitle");
  await page.fill("#docTitle", name);
  await page.keyboard.press("Enter");
}

async function joinSharedWorkspace(page: import("@playwright/test").Page, shareUrl: string) {
  await page.goto(shareUrl);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = page.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(page);
}

// Proves the cascade's shared-document path actually reaches the Durable
// Object over the real Worker endpoint, not just the renaming client's
// own local cache: Linker is a background document for both participants
// at the moment of rename (Target is the one open), so the only way its
// content could update is the HTTP push landing server-side and syncing
// back out through the normal Yjs broadcast.
//
// Everything here goes through real UI actions and window.MDE, not a
// dynamic import of app source — this project serves against wrangler
// dev (:8787), which only serves the pre-built client/dist bundle, so a
// raw `import("/src/stores/docs.ts")` (fine against the "local"
// project's plain Vite dev server) 404s here.
//
// Linker (not Target) is the ACTIVE document at the moment the workspace
// is first shared, on purpose: sharing a brand-new (never-connected)
// workspace only ever seeds *whichever document is active at invite
// time* into the freshly-created room (see collab.ts's addPerson/
// setAccessMode and joinWorkspace's own "seedDocId" comment) — every
// other pre-existing local document is left with no live binding at
// all until something else visits it. Target doesn't need a seeded
// binding for this test (its own rename stays a plain local edit, which
// works regardless), but Linker's typed content has to actually reach
// the room for the cascade's HTTP push to have anything real to rewrite.
test("renaming a document while a second collaborator is connected updates a background document's [[link]] for both", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const collabCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const collaborator = await collabCtx.newPage();

  await signInAsDevUser(owner, "wr-owner-e2e");
  await signInAsDevUser(collaborator, "wr-collab-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);

  const targetId = await owner.evaluate(() => localStorage.getItem("mde:active"));
  await renameActiveDoc(owner, "Target");

  // Linker: a second document in the same (not-yet-shared) workspace,
  // referencing Target by name. Left as the ACTIVE document — see the
  // top-of-test comment on why that matters for sharing.
  await owner.evaluate(() => window.MDE.newDoc());
  await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  const linkerId = await owner.evaluate(() => localStorage.getItem("mde:active"));
  await renameActiveDoc(owner, "Linker");
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("See [[Target]] here");
  await owner.waitForTimeout(50); // let the wikilink autocomplete menu close on its own via the trailing "]]"

  await owner.click('button:has-text("Share")');
  // Linker has a sibling document (Target), so Share first asks whether
  // to share just this document or the whole workspace — see
  // ShareChoiceModal.svelte. The cascade needs the whole workspace
  // shared (Target has to be reachable too, for its own rename), so
  // always choose that.
  const shareWholeWorkspace = owner.locator('button:has-text("Share whole workspace")');
  await shareWholeWorkspace.waitFor({ state: "visible", timeout: 5000 });
  await shareWholeWorkspace.click();

  const addPeopleInput = owner.locator('input[aria-label="Add people by GitHub username"]');
  await addPeopleInput.waitFor({ state: "visible" });
  await addPeopleInput.fill("wr-collab-e2e");
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    addPeopleInput.press("Enter"),
  ]);
  const roleSelect = owner.locator('select[aria-label="Access level for wr-collab-e2e"]');
  await roleSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    roleSelect.selectOption({ label: "Editor" }),
  ]);

  // Linker is still the active document here — this invite is what
  // actually seeds it into the new room (see the top-of-test comment).
  const shareState = await owner.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  expect(shareState.ws?.shared).toBe(true);
  expect(shareState.activeDoc?.id).toBe(linkerId);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;

  const doneBtn = owner.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await owner.keyboard.press("Escape").catch(() => {});

  // Collaborator's initial landing doc is Linker (shareUrl encodes it) —
  // confirms it synced correctly on first join, before any rename.
  await joinSharedWorkspace(collaborator, shareUrl);
  await expect.poll(() => collaborator.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toBe("See [[Target]] here");

  // Owner switches to Target and renames it. Neither participant has
  // Linker open at this point (owner is on Target; collaborator, per
  // the assertion above, is looking at Linker's *pre-rename* content
  // but isn't touching it) — the only path for Linker's own content to
  // update is the cascade's HTTP push to the Durable Object.
  await owner.evaluate((id) => window.MDE.switchDoc(id!), targetId);
  await expect.poll(() => owner.evaluate(() => localStorage.getItem("mde:active"))).toBe(targetId);
  await renameActiveDoc(owner, "Renamed");
  // Scoped by text, not just ".toast-message": the invite flow's own
  // "Invited @..."/"access set to..." toasts can still be on screen
  // (each has a multi-second auto-dismiss) when this one fires.
  await expect(owner.locator(".toast-message", { hasText: 'Updated 1 link to "Renamed"' })).toBeVisible();

  // Confirm it landed for the second participant's independent client
  // FIRST, while it's still sitting on Linker exactly as it has been
  // since joining — its own live binding just receives the Durable
  // Object's broadcast update in place, proving the fix reached the
  // room itself, not just the renaming client's local cache.
  await expect.poll(() => collaborator.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""), { timeout: 10000 }).toBe("See [[Renamed]] here");

  await ownerCtx.close();
  await collabCtx.close();
});
