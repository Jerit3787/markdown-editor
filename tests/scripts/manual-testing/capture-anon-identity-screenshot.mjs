// One-off: captures the What's New screenshot for anonymous collaborator
// identity (client/public/whats-new/anon-identity.png) — two anonymous
// reviewers' suggestions in the annotation rail, each attributed to their
// own server-assigned guest name instead of a shared "Anonymous".
//
// Not part of the test suite — run manually against a wrangler dev
// instance with the dev-login route applied (see enable-dev-login.sh):
//
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npx wrangler dev --local-upstream localhost:8787 &
//   node tests/scripts/manual-testing/capture-anon-identity-screenshot.mjs
//   kill %1; bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/anon-identity.png";
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

async function joinAsGuest(browser, shareUrl, insertText) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(shareUrl);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const keep = page.locator('button:has-text("Add as new workspace"), button:has-text("Keep this workspace")').first();
  if (await keep.isVisible({ timeout: 3000 }).catch(() => false)) await keep.click();
  await dismissWhatsNew(page);
  await page.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Launch announcement"), { timeout: 15000 });
  await page.click("#editor-mount .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(insertText);
  return ctx;
}

const browser = await chromium.launch(existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {});
const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const owner = await ownerCtx.newPage();

await signIn(owner, "shot-owner");
await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn");
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Launch announcement\n\nWe're rolling the new features out to everyone this week.\n\nThe rollout starts Thursday.");

// Share publicly with a Reviewer link role so anonymous visitors can propose edits.
await owner.click('button:has-text("Share")');
const cont = owner.locator('button:has-text("Continue")');
if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) await cont.click();
const accessSelect = owner.locator('select[aria-label="General access"]');
await accessSelect.waitFor({ state: "visible" });
await Promise.all([
  owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"),
  accessSelect.selectOption({ label: "Anyone with the link" }),
]);
await Promise.all([
  owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"),
  owner.locator('select[aria-label="Access level for people with the link"]').selectOption({ label: "Reviewer" }),
]);
const state = await owner.evaluate(() => {
  const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const d = docs.find((x) => x.id === localStorage.getItem("mde:active"));
  return { d, ws: wss.find((w) => w.id === d?.workspaceId) };
});
await owner.keyboard.press("Escape").catch(() => {});
const shareUrl = `${BASE}/w/${state.ws.remoteId}/${state.d.id}/edit`;

// Two anonymous guests join and each proposes an edit (-> a suggestion).
const guestA = await joinAsGuest(browser, shareUrl, " Marketing sends the newsletter the same morning.");
const guestB = await joinAsGuest(browser, shareUrl, " Support staffing is doubled for launch day.");

await owner.waitForFunction(() => document.querySelectorAll(".cm-suggestion-insert").length >= 2, { timeout: 20000 });

// Owner opens the annotation rail; let toasts settle, then screenshot.
await owner.click("#commentsBtn");
await owner.locator(".annotation-card.suggestion").first().waitFor({ state: "visible", timeout: 10000 });
await owner.waitForFunction(() => document.querySelectorAll(".annotation-card.suggestion").length >= 2, { timeout: 10000 });
await owner.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0 } }));
await owner.mouse.move(680, 400);
await owner.waitForTimeout(4000);

await owner.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await guestA.close();
await guestB.close();
await ownerCtx.close();
await browser.close();
