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

// CMT-14 — a comment's editor highlight tracks live edits: it follows an
// insertion made above its range, and disappears once its quoted text is
// deleted. relocateAnchor's pure logic is unit-covered (CMT-02); this is
// the live-editor + cross-collaborator integration.
test("CMT-14: a comment highlight follows edits made above it and drops when its quoted text is deleted", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const peerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const peer = await peerCtx.newPage();

  await ownerWithDoc(owner, "cmt14-owner-e2e", "the quick brown fox");
  const url = await shareAnyoneLink(owner, "Editor");
  await joinSharedWorkspace(peer, url);
  await expectEditorContains(peer, "the quick brown fox");

  // Owner comments on "quick".
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await owner.keyboard.press("ArrowRight");
  await owner.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await owner.keyboard.press("ArrowRight");
  await owner.keyboard.up("Shift");
  await owner.click('button:has-text("Add comment")');
  await owner.fill(".comment-draft-box textarea", "why?");
  await owner.click(".comment-draft-box button.primary-btn");

  await expect(peer.locator(".cm-comment-marker")).toBeVisible({ timeout: 15000 });
  expect((await owner.locator(".cm-comment-marker").first().textContent())?.trim()).toBe("quick");

  // Peer inserts text at the very start — the anchor shifts to stay on "quick".
  await peer.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, insert: "PREFIX " } });
  });
  await expectEditorContains(owner, "PREFIX the quick");
  await expect
    .poll(
      () =>
        owner
          .locator(".cm-comment-marker")
          .first()
          .textContent()
          .then((t) => t?.trim()),
      { timeout: 10000 },
    )
    .toBe("quick");

  // Peer deletes the word "quick" — the highlight drops on both sides.
  await peer.evaluate(() => {
    const cm = window.MDE.getEditor();
    const i = cm.state.doc.toString().indexOf("quick");
    cm.dispatch({ changes: { from: i, to: i + "quick ".length, insert: "" } });
  });
  await expect(owner.locator(".cm-comment-marker")).toHaveCount(0, { timeout: 10000 });
  await expect(peer.locator(".cm-comment-marker")).toHaveCount(0, { timeout: 10000 });

  await ownerCtx.close();
  await peerCtx.close();
});
