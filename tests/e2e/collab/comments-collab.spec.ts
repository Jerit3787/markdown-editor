import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, expectEditorContains } from "./support/collab";

// CMT-15 — adding / resolving / deleting a comment on a shared document
// propagates LIVE to another already-connected collaborator (no reload),
// via the room's MESSAGE_COMMENTS broadcast.
test("CMT-15: a comment added, resolved and deleted on a shared doc propagates live to the other collaborator", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const peerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const peer = await peerCtx.newPage();

  await ownerWithDoc(owner, "cmt-owner-e2e", "the quick brown fox");
  const url = await shareAnyoneLink(owner, "Editor");
  await joinSharedWorkspace(peer, url);
  await expectEditorContains(peer, "the quick brown fox");
  await peer.click("#commentsBtn"); // peer watches the panel

  // Owner selects "quick" and comments on it.
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await owner.keyboard.press("ArrowRight");
  await owner.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await owner.keyboard.press("ArrowRight");
  await owner.keyboard.up("Shift");
  await owner.click('button:has-text("Add comment")');
  await owner.fill(".comment-draft-box textarea", "why quick?");
  await owner.click(".comment-draft-box button.primary-btn");

  // Peer sees the highlight and the comment body appear WITHOUT reloading.
  await expect(peer.locator(".cm-comment-marker")).toBeVisible({ timeout: 15000 });
  await expect(peer.locator('text="why quick?"')).toBeVisible({ timeout: 10000 });

  // Owner resolves it → the peer's entry flips its button to "Reopen".
  await owner.click("#commentsBtn");
  await owner.locator(".comment-entry", { hasText: "why quick?" }).getByRole("button", { name: "Resolve" }).click();
  await expect(peer.locator(".comment-entry", { hasText: "why quick?" }).getByRole("button", { name: "Reopen" })).toBeVisible({ timeout: 10000 });

  // Owner deletes it → the peer's highlight disappears live.
  await owner.locator(".comment-entry", { hasText: "why quick?" }).locator(".comment-delete-btn").click();
  await expect(peer.locator(".cm-comment-marker")).toHaveCount(0, { timeout: 10000 });

  await ownerCtx.close();
  await peerCtx.close();
});
