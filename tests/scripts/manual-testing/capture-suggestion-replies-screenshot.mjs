// One-off script to capture the What's New screenshot for suggestion
// reply threads (client/public/whats-new/suggestion-replies.png). Not
// part of the test suite — run manually against a wrangler dev instance
// with the dev-login route applied (see enable-dev-login.sh).
//
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npx wrangler dev --local-upstream localhost:8787 &
//   node tests/scripts/manual-testing/capture-suggestion-replies-screenshot.mjs
//   kill %1; bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/suggestion-replies.png";
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";

async function signIn(page, username) {
  await page.route("**/api/auth/github/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) }),
  );
  await page.goto(`${BASE}/api/dev/login?username=${username}`);
}

async function dismissWhatsNew(page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
}

const browser = await chromium.launch(existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {});
const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
const reviewerCtx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
const owner = await ownerCtx.newPage();
const reviewer = await reviewerCtx.newPage();

await signIn(owner, "shot-owner");
await signIn(reviewer, "shot-reviewer");

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn");
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type(
  "# Launch announcement\n\nWe're excited to share the new collaboration features with everyone this week.\n\nThe rollout starts Thursday.",
);

// Share with a reviewer.
await owner.click('button:has-text("Share")');
const moveDialog = owner.locator('button:has-text("Continue")');
if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
const addPeopleInput = owner.locator('input[aria-label="Add people by GitHub username"]');
await addPeopleInput.waitFor({ state: "visible" });
await addPeopleInput.fill("shot-reviewer");
await Promise.all([
  owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
  addPeopleInput.press("Enter"),
]);
const roleSelect = owner.locator('select[aria-label="Access level for shot-reviewer"]');
await roleSelect.waitFor({ state: "visible" });
await Promise.all([
  owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
  roleSelect.selectOption({ label: "Reviewer" }),
]);
const shareState = await owner.evaluate(() => {
  const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const activeDoc = docs.find((d) => d.id === localStorage.getItem("mde:active"));
  return { activeDoc, ws: workspaces.find((w) => w.id === activeDoc?.workspaceId) };
});
const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;
const doneBtn = owner.locator('button:has-text("Done")');
if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
await owner.keyboard.press("Escape").catch(() => {});

// Reviewer joins and proposes an edit (which becomes a suggestion).
await reviewer.goto(shareUrl);
await reviewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const joinModal = reviewer.locator('text="Join shared workspace"');
if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) await reviewer.click('button:has-text("Add as new workspace")');
await dismissWhatsNew(reviewer);
await reviewer.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Launch announcement"), { timeout: 15000 });
await reviewer.click("#editor-mount .cm-content");
await reviewer.keyboard.press("Control+End");
await reviewer.keyboard.insertText(" Marketing will send the newsletter the same morning.");

await owner.waitForSelector(".cm-suggestion-insert", { timeout: 15000 });

// Owner opens the rail, focuses the suggestion card and replies on it.
await owner.click("#commentsBtn");
const sugCard = owner.locator(".annotation-card.suggestion").first();
await sugCard.waitFor({ state: "visible", timeout: 10000 });
await sugCard.hover();
await sugCard.getByPlaceholder(/reply/i).fill("Good call — let's confirm the send time with them.");
await sugCard.getByRole("button", { name: "Reply" }).click();
await owner.waitForFunction(() => !!document.querySelector(".annotation-card.suggestion .annotation-card-reply"), { timeout: 10000 });
await sugCard.hover();

// Clear the selection so the floating "Add comment" affordance goes away.
await owner.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0 } }));
await owner.mouse.move(680, 400);
await owner.waitForTimeout(3800); // let the invite/access toasts auto-dismiss
await sugCard.hover();

await owner.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await reviewerCtx.close();
await browser.close();
