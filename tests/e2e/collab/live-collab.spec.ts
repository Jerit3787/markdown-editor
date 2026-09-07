import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, editorText, expectEditorContains, BASE } from "./support/collab";
import { signInAsDevUser } from "./support/dev-login";

test("COLLAB-13: two collaborators editing concurrently converge in both directions", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "conv-a-e2e", "MIDDLE");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "MIDDLE");

  // Both edit concurrently (A at the start, B at the end of the line).
  await a.click("#editor-mount .cm-content");
  await a.keyboard.press("ControlOrMeta+ArrowLeft");
  await a.keyboard.type("A-EDIT ");

  await b.click("#editor-mount .cm-content");
  await b.keyboard.press("ControlOrMeta+ArrowRight");
  await b.keyboard.type(" B-EDIT");

  // The CRDT converges: both edits land, on both sides, to identical text.
  await expectEditorContains(a, "A-EDIT");
  await expectEditorContains(a, "B-EDIT");
  await expectEditorContains(b, "A-EDIT");
  await expectEditorContains(b, "B-EDIT");
  await expect.poll(async () => (await editorText(a)) === (await editorText(b))).toBe(true);
  expect(await editorText(a)).toContain("MIDDLE");

  await aCtx.close();
  await bCtx.close();
});

test("COLLAB-25: a single-doc share link is received as its own new workspace named after the doc, with no join modal", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "singledoc-a-e2e", "the only document");
  const url = await shareAnyoneLink(a, "Editor");

  await b.goto(url);
  await b.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });

  // No "Join shared workspace" modal for a single-doc link — it lands
  // directly as its own new workspace (b started with none).
  await expect(b.locator('text="Join shared workspace"')).toHaveCount(0);
  await expectEditorContains(b, "the only document");

  const ws = await b.evaluate(() => {
    const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const activeWs = localStorage.getItem("mde:activeWorkspace");
    return wss.find((w: { id: string }) => w.id === activeWs) ?? null;
  });
  expect(ws).not.toBeNull();
  expect(ws.remoteId).toBeTruthy(); // linked to the shared room
  // Named for the doc, not the generic multi-doc "Shared workspace".
  expect(ws.name).not.toBe("Shared workspace");
  expect(ws.name).not.toBe("New workspace");

  await aCtx.close();
  await bCtx.close();
});

test("COLLAB-25: a joiner receives the document's real name, not the 'Shared document' fallback", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "docname-owner-e2e", "body text");
  await a.click("#docTitle");
  await a.fill("#docTitle", "Design Doc");
  await a.keyboard.press("Enter");
  const url = await shareAnyoneLink(a, "Editor");

  await b.goto(url);
  await b.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await expectEditorContains(b, "body text");

  // fetchRemoteDocContent must wait for the SyncStep2 that actually carries
  // the doc's meta.name — not resolve on the server's greeting SyncStep1,
  // which would leave every joined document showing "Shared document".
  await expect.poll(() => b.locator("#docTitle").inputValue()).toBe("Design Doc");
  const names = await b.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { name: string }) => d.name));
  expect(names).toContain("Design Doc");
  expect(names).not.toContain("Shared document");

  await aCtx.close();
  await bCtx.close();
});

test("COLLAB-23b: the topbar Share dropdown shows the real general-access level, not always 'Restricted'", async ({ browser }) => {
  const ctx = await browser.newContext();
  const owner = await ctx.newPage();

  await ownerWithDoc(owner, "share-dropdown-e2e", "body");
  await shareAnyoneLink(owner, "Editor"); // sets general access to "anyone with the link"

  // Open the split-button dropdown next to Share.
  await owner.click("#shareDropdownBtn");
  await expect(owner.locator("#shareAccessTitle")).toHaveText("Anyone with the link", { timeout: 5000 });

  await ctx.close();
});

test("COLLAB-23a: a joined non-owner's Share modal shows the real access and copies a room-id link", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const peerCtx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const owner = await ownerCtx.newPage();
  const peer = await peerCtx.newPage();

  await ownerWithDoc(owner, "share-owner-e2e", "shared body");
  const url = await shareAnyoneLink(owner, "Editor");
  const roomId = url.match(/\/w\/([^/]+)\//)![1]!;

  // A different signed-in GitHub user joins the link as their own new workspace.
  await signInAsDevUser(peer, "share-peer-e2e");
  await joinSharedWorkspace(peer, url);
  await expectEditorContains(peer, "shared body");

  const localWsId = await peer.evaluate(() => {
    const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const active = localStorage.getItem("mde:activeWorkspace");
    return wss.find((w: { id: string }) => w.id === active)?.id ?? null;
  });
  expect(localWsId).toBeTruthy();
  expect(localWsId).not.toBe(roomId);

  await peer.click("#shareBtn");
  // The General-access select reflects the real setting (was always "restricted").
  await expect(peer.locator('select[aria-label="General access"]')).toHaveValue("anyone-link", { timeout: 5000 });

  // ...and it's read-only for a non-owner, with the owner-only hint and the real owner.
  await expect(peer.locator('select[aria-label="General access"]')).toBeDisabled();
  await expect(peer.locator('select[aria-label="Access level for people with the link"]')).toBeDisabled();
  await expect(peer.locator('text="Only the workspace\'s owner can change who has access."')).toBeVisible();
  await expect(peer.locator(".share-person-owner .share-person-name")).toHaveText("share-owner-e2e");

  await peer.locator('button.secondary-btn:has-text("Copy link")').click();
  const copied = await peer.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`/w/${roomId}/`);
  expect(copied).not.toContain(`/w/${localWsId}/`);

  await ownerCtx.close();
  await peerCtx.close();
});
