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
// context with zero workspaces (see live-sync.spec.ts) — #emptyNewWorkspaceBtn
// is the real empty-state UI's own "create a workspace" action.
async function createFirstWorkspaceAndDoc(page: import("@playwright/test").Page) {
  await page.click("#emptyNewWorkspaceBtn");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
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

test("a reviewer's edits become suggestions an editor can accept or reject, and a viewer sees preview-only", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const reviewerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const reviewer = await reviewerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "sugg-owner-e2e");
  await signInAsDevUser(reviewer, "sugg-reviewer-e2e");
  await signInAsDevUser(viewer, "sugg-viewer-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("owner-authored content");

  // Own workspace as-is, then invite the reviewer and viewer by username
  // at distinct roles — general access stays "restricted" throughout, so
  // each invited username's own per-person role (not a single shared link
  // role) is what authorize() resolves server-side. This is the only way
  // to get two different non-owner roles live in the same room at once.
  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();

  const addPeopleInput = owner.locator('input[aria-label="Add people by GitHub username"]');
  await addPeopleInput.waitFor({ state: "visible" });

  async function invite(username: string, role: "reviewer" | "viewer") {
    await addPeopleInput.fill(username);
    await Promise.all([
      owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
      addPeopleInput.press("Enter"),
    ]);
    const roleSelect = owner.locator(`select[aria-label="Access level for ${username}"]`);
    await roleSelect.waitFor({ state: "visible" });
    await Promise.all([
      owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
      roleSelect.selectOption({ label: role === "reviewer" ? "Reviewer" : "Viewer" }),
    ]);
  }
  await invite("sugg-reviewer-e2e", "reviewer");
  await invite("sugg-viewer-e2e", "viewer");

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

  const doneBtn = owner.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await owner.keyboard.press("Escape").catch(() => {});

  await joinSharedWorkspace(reviewer, shareUrl);
  await expect.poll(() => reviewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("owner-authored content");

  // Reviewer types text and confirms it renders as an underlined
  // suggestion, not plain committed text — both in the editor pane and
  // in the Preview pane (Google Docs-style ins/del parity).
  await reviewer.click("#editor-mount .cm-content");
  await reviewer.keyboard.press("Control+End");
  // insertText (one CDP Input.insertText command, like a paste or an IME
  // commit) rather than .type() (one real keydown per character): a real
  // reviewer's ytext insert and its own suggestion-map entry always leave
  // the client as two separate Yjs updates (y-codemirror.next's ySync
  // plugin and suggestion-editor.ts's suggestionInsertListener each call
  // doc.transact() independently) — WorkspaceRoom's own reconciliation
  // can momentarily wrap the same insert from both sides before the
  // second update lands, self-healing via the suggestions-map dedup in
  // loadDocRoom. .type()'s one-keydown-per-character pacing (zero delay,
  // far faster than any real typist) stresses that window on every single
  // character; insertText matches how a paste or an IME commit actually
  // arrives — one edit, one race window, same as a real fast typist's
  // burst rather than the artificial worst case.
  await reviewer.keyboard.insertText(" proposed addition");
  // A longer timeout than this file's other assertions: this one keeps
  // polling through the dedup's own settle time, longer still when the
  // full collab suite's parallel workers are contending for the same
  // wrangler dev instance.
  await expect(reviewer.locator(".cm-suggestion-insert")).toBeVisible({ timeout: 15000 });
  await expect(reviewer.locator("#preview .suggestion-insert")).toContainText("proposed addition", { timeout: 15000 });

  // Owner (editor via ownership) sees the same suggestion and accepts it.
  await expect(owner.locator(".cm-suggestion-insert")).toBeVisible({ timeout: 10000 });
  await owner.locator(".cm-suggestion-action[data-action='accept']").click();
  await expect(owner.locator(".cm-suggestion-insert")).toHaveCount(0);
  await expect(reviewer.locator(".cm-suggestion-insert")).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => owner.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("proposed addition");

  // Reviewer selects text and deletes it — confirms it's struck through,
  // not actually removed, until the owner resolves it. Rejecting keeps
  // the text in place.
  await reviewer.keyboard.press("Control+Home");
  await reviewer.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await reviewer.keyboard.press("ArrowRight");
  await reviewer.keyboard.up("Shift");
  await reviewer.keyboard.press("Backspace");
  await expect(reviewer.locator(".cm-suggestion-delete")).toBeVisible();
  await expect(owner.locator(".cm-suggestion-delete")).toBeVisible({ timeout: 10000 });
  await owner.locator(".cm-suggestion-action[data-action='reject']").click();
  await expect(owner.locator(".cm-suggestion-delete")).toHaveCount(0);
  await expect.poll(() => owner.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("owner");

  // Viewer sees Preview only — no editor pane, no Editor/Split option in
  // either the toolbar or the View menu, and typing does nothing since
  // there's no editable surface to type into.
  await joinSharedWorkspace(viewer, shareUrl);
  await expect(viewer.locator("#editor-mount")).toBeHidden();
  await expect(viewer.locator("#preview")).toBeVisible();
  await expect(viewer.locator(".view-selector")).toHaveCount(0);
  await viewer.click("#viewMenuBtn");
  await expect(viewer.locator(".menu-view-btn", { hasText: "Editor pane" })).toHaveCount(0);
  await expect(viewer.locator(".menu-view-btn", { hasText: "Preview pane" })).toHaveCount(0);

  await ownerCtx.close();
  await reviewerCtx.close();
  await viewerCtx.close();
});
