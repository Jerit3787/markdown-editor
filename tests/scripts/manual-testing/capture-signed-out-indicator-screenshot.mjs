// One-off script to capture the What's New screenshot for the signed-out
// indicator (client/public/whats-new/signed-out-indicator.png). Not part
// of the test suite — run manually against a wrangler dev instance with
// the dev-login route applied (see enable-dev-login.sh).
//
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npx wrangler dev --port 8787 &   # wait for ready
//   node tests/scripts/manual-testing/capture-signed-out-indicator-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/signed-out-indicator.png";

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

// Uses whatever chromium `npx playwright install chromium` put in
// Playwright's own cache. In a sandbox whose cache lags the pinned
// version, pass { executablePath: "/opt/pw-browsers/chromium" } (or
// whatever `ls /opt/pw-browsers/` shows) — same workaround the CLAUDE.md
// e2e note describes.
const browser = await chromium.launch();
const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// The viewer here IS signed in — the signed-out indicator is for the case
// where a real owner / invited collaborator's session has expired, so the
// link's general access is silently standing in for a role they should
// have by identity. An anonymous visitor with no session at all lands in
// the same UI (identityUnverified), and dev-login gives us a session that
// still resolves a role via the anyone-link while reading as "unverified".
const viewerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const owner = await ownerCtx.newPage();
const viewer = await viewerCtx.newPage();

await signIn(owner, "shot-sig-owner");
// Deliberately NO signIn for the viewer — a visitor with no GitHub session
// at all opening an anyone-with-the-link workspace is exactly what
// isIdentityUnverified() flags and the indicator exists for.

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn");
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Team Notes\n\nShared with anyone who has the link.");

await owner.click('button:has-text("Share")');
const moveDialog = owner.locator('button:has-text("Continue")');
if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
const accessSelect = owner.locator('select[aria-label="General access"]');
await accessSelect.waitFor({ state: "visible" });
await Promise.all([
  owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
  accessSelect.selectOption({ label: "Anyone with the link" }),
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

await viewer.goto(shareUrl);
await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const joinModal = viewer.locator('text="Join shared workspace"');
if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
  await viewer.click('button:has-text("Add as new workspace")');
}
await dismissWhatsNew(viewer);

const indicator = viewer.locator('button.signed-out-indicator:has-text("Signed out")');
await indicator.waitFor({ state: "visible", timeout: 15000 });
// Open the "Sign in required" popover so the screenshot shows what the
// indicator is *for*, not just a lone status-bar chip.
await indicator.click();
await viewer.locator('text="Sign in required"').waitFor({ state: "visible", timeout: 5000 });
await viewer.waitForTimeout(300);

await viewer.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await viewerCtx.close();
await browser.close();
