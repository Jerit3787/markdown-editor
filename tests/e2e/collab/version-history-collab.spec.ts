import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, expectEditorContains } from "./support/collab";
import { signInAsDevUser } from "./support/dev-login";

// VER-08 — a collaborator who *joined* a shared workspace (its local
// workspace id differs from the Durable Object's id) can browse that
// document's server-side version history. Regression lock for the
// remoteId-resolution bug: VersionHistory.svelte passed doc.workspaceId
// straight to /api/workspace/:id/..., which 403s for everyone but the
// room's original owner — so both listSharedVersions (empty list) and
// getSharedVersionSnapshot ("couldn't load" toast) failed for every
// joiner. The owner path is already covered by the unit/integration
// suites; this is specifically the joiner.
test("VER-08: a joined collaborator can browse a shared document's server-side version history", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const peerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const peer = await peerCtx.newPage();

  await ownerWithDoc(owner, "ver-owner-e2e", "");
  const url = await shareAnyoneLink(owner, "Editor");
  await joinSharedWorkspace(peer, url);

  // Two edits so the room captures at least one snapshot (maybeSnapshot
  // fires on the first sync update; its 30s gate then blocks the second).
  await owner.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "first revision" } });
  });
  await expectEditorContains(peer, "first revision");
  await owner.waitForTimeout(1500);
  await owner.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "second revision" } });
  });
  await expectEditorContains(peer, "second revision");

  // The peer opens Version History: the list loads over the room id (not
  // its local workspace id), so it is NOT empty...
  await peer.click("#versionHistoryBtn");
  await expect(peer.locator(".version-history-overlay")).toBeVisible();
  await expect(peer.locator(".version-history-row").first()).toBeVisible({ timeout: 10000 });

  // ...and selecting a row loads its snapshot from the room without the
  // "couldn't load this version's content" failure toast.
  await peer.locator(".version-history-row").first().click();
  await peer.waitForTimeout(1000);
  await expect(peer.locator("text=\"Couldn't load this version's content\"")).toHaveCount(0);

  await ownerCtx.close();
  await peerCtx.close();
});

// VER-17 — a shared version snapshot is attributed to the collaborator
// whose edits it captured. (The first snapshot in an editing burst records
// only the first editor — the 30s throttle holds later ones for the next
// capture — so this asserts the owner, whose edit lands first.)
test("VER-17: a shared version is attributed to the collaborator who edited it", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const peerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const peer = await peerCtx.newPage();

  await ownerWithDoc(owner, "ver17-owner", "");
  const url = await shareAnyoneLink(owner, "Editor");
  await signInAsDevUser(peer, "ver17-peer");
  await joinSharedWorkspace(peer, url);

  await owner.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "owner line" } });
  });
  await expectEditorContains(peer, "owner line");

  await peer.click("#versionHistoryBtn");
  const authors = peer.locator(".version-history-row .version-history-authors").first();
  await expect(authors).toBeVisible({ timeout: 10000 });
  await expect(authors).toHaveAttribute("title", /ver17-owner/);

  await ownerCtx.close();
  await peerCtx.close();
});
