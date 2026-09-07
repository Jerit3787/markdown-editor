import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";
import { dismissWhatsNew, joinSharedWorkspace, editorText, expectEditorContains, BASE } from "./support/collab";
import { mintDevSession, seedLegacyCollabRoom } from "./support/legacy-room";

// COLLAB-39: a document still carrying the pre-workspace per-document
// `shared: true` flag migrates its legacy CollabRoom into a fresh
// WorkspaceRoom the moment it's opened — transparently, before live sync
// attaches — and the migrated room then works like any other shared
// workspace. Only the server halves (handleMigrateRequest tombstone,
// /internal/seed) were covered before, at integration level.
//
// Setup path: pre-seeded localStorage. normalizeLoadedDocs (stores/docs.ts)
// spreads the stored record, so `shared: true` survives the load
// unchanged — no need to drive the stores through the app.
test("COLLAB-39: a legacy per-document shared doc migrates to a WorkspaceRoom on open", async ({ browser }) => {
  const docId = `legacy-${Date.now().toString(36)}`;
  const ownerCookie = await mintDevSession("legacy-owner-e2e");
  await seedLegacyCollabRoom({ docId, ownerCookie, content: "LEGACY SHARED CONTENT", name: "Legacy Doc" });

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signInAsDevUser(owner, "legacy-owner-e2e");
  await owner.addInitScript((id) => {
    const now = Date.now();
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "legacy-ws-local", name: "Old Workspace", createdAt: now, updatedAt: now }]));
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id, name: "Legacy Doc", workspaceId: "legacy-ws-local", content: "", shared: true, createdAt: now, updatedAt: now }]),
    );
    localStorage.setItem("mde:active", id);
    localStorage.setItem("mde:activeWorkspace", "legacy-ws-local");
  }, docId);

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);

  // Migration ran: the editor shows the room's content, not the empty
  // local record.
  await expect.poll(() => editorText(owner), { timeout: 15000 }).toBe("LEGACY SHARED CONTENT");

  // The legacy flag is cleared and the doc now lives in an adopted
  // workspace that has a remoteId.
  const readMigratedState = () =>
    owner.evaluate(() => {
      const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
      const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
      const d = docs.find((x: { name: string }) => x.name === "Legacy Doc");
      const ws = d && wss.find((w: { id: string }) => w.id === d.workspaceId);
      return { shared: (d?.shared ?? null) as boolean | null, remoteId: (ws?.remoteId ?? null) as string | null };
    });
  await expect.poll(async () => (await readMigratedState()).remoteId, { timeout: 15000 }).not.toBeNull();
  const state = await readMigratedState();
  expect(state.shared).toBeNull();
  expect(typeof state.remoteId).toBe("string");
  expect(state.remoteId!.length).toBeGreaterThan(0);

  // Live sync works on the migrated room: a second collaborator joins by
  // the modern /w/<remoteId>/<docId>/edit link and sees content + a live
  // edit.
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await signInAsDevUser(viewer, "legacy-viewer-e2e");
  await joinSharedWorkspace(viewer, `${BASE}/w/${state.remoteId}/${docId}/edit`);
  await expectEditorContains(viewer, "LEGACY SHARED CONTENT");

  await owner.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: " + edit" } });
  });
  await expectEditorContains(viewer, "LEGACY SHARED CONTENT + edit");

  await ownerCtx.close();
  await viewerCtx.close();
});
