// One-off script to capture the What's New screenshot for the
// workspace-access-denied banner (client/public/whats-new/workspace-access-denied.png).
// Not part of the test suite — run manually against a wrangler dev instance
// with the dev-login route applied (see enable-dev-login.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/workspace-access-denied.png";

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

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// Deliberately no dev-login for this context — a completely unauthenticated
// visitor is exactly the "no-session" case the banner's Sign in button is for.
const strangerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const owner = await ownerCtx.newPage();
const stranger = await strangerCtx.newPage();

await signIn(owner, "shot-wad-owner");

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn");
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Roadmap\n\nOwner-only draft, restricted access.");

await owner.click('button:has-text("Share")');
const moveDialog = owner.locator('button:has-text("Continue")');
if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
// Inviting a specific person keeps general access restricted — a
// signed-out stranger gets no role at all, the "no-session" case.
const addInput = owner.locator('input[aria-label="Add people by GitHub username"]');
await addInput.waitFor({ state: "visible" });
await addInput.fill("someone-else-entirely");
await Promise.all([
  owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
  owner.keyboard.press("Enter"),
]);

const shareState = await owner.evaluate(() => {
  const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const activeId = localStorage.getItem("mde:active");
  const activeDoc = docs.find((d) => d.id === activeId);
  const ws = workspaces.find((w) => w.id === activeDoc?.workspaceId);
  return { activeDoc, ws };
});
const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;
await owner.keyboard.press("Escape").catch(() => {});

await stranger.goto(shareUrl);
await stranger.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(stranger);

await stranger.waitForSelector(".workspace-access-banner", { timeout: 15000 });
// Let the "invited"/"access set to" toasts (3.2s auto-dismiss) clear on
// the owner's side before capturing the stranger's page — not strictly
// necessary here since they're separate browser contexts, but keeps
// timing consistent with the other capture scripts.
await stranger.waitForTimeout(500);

await stranger.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await strangerCtx.close();
await browser.close();
