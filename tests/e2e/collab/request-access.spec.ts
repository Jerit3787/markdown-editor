import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace } from "./support/collab";
import { signInAsDevUser } from "./support/dev-login";

// CV2-5 — a viewer asks for edit access; the owner approves; the viewer's
// editor surface unlocks live, no reload.
test("a viewer requests edit access and an approval takes effect immediately", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "req-owner-e2e", "the shared body");
  const url = await shareAnyoneLink(a, "Viewer");
  // The requester must be a signed-in account (a joined viewer/reviewer).
  await signInAsDevUser(b, "req-viewer-e2e");
  await joinSharedWorkspace(b, url);
  await expect.poll(() => b.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("the shared body");

  // B is a viewer — the mode chrome reflects it, and the Share button is
  // greyed (but still clickable — it's the request entry point).
  await expect(b.locator("#shareBtn")).toHaveClass(/is-muted/);
  await expect(b.locator("#formatMenuBtn")).toBeHidden();

  // B clicks the greyed Share button → the Request edit access modal opens.
  await b.locator("#shareBtn").click();
  await expect(b.getByText("Request edit access")).toBeVisible();
  await b.getByLabel("Add a note to the owner (optional)").fill("need to fix a typo");
  await b.getByRole("button", { name: "Send request" }).click();
  await expect(b.getByText("Request edit access")).toBeHidden();

  // A sees it in the Share dialog (a badge + a Requests row).
  await a.locator("#shareBtn").click();
  await expect(a.getByText("Requests")).toBeVisible();
  await expect(a.getByText("need to fix a typo")).toBeVisible();
  await a.getByRole("button", { name: "Approve" }).click();

  // B's role is bumped to editor live — the formatting menu comes back and
  // the Share button is no longer greyed, with no reload.
  await expect(b.locator("#formatMenuBtn")).toBeVisible({ timeout: 10_000 });
  await expect(b.locator("#shareBtn")).not.toHaveClass(/is-muted/);

  await aCtx.close();
  await bCtx.close();
});
