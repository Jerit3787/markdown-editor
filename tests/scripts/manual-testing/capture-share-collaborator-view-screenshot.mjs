// One-off: captures the What's New screenshot for the joined-collaborator
// Share dialog (client/public/whats-new/share-collaborator-view.png).
// Not part of the test suite — run manually against a wrangler dev
// instance with the dev-login route applied (see enable-dev-login.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/share-collaborator-view.png";

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
const peerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const owner = await ownerCtx.newPage();
const peer = await peerCtx.newPage();

await signIn(owner, "maria");
await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn");
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Team Handbook\n\nShared with the whole team.");

await owner.click('button:has-text("Share")');
const cont = owner.locator('button:has-text("Continue")');
if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) await cont.click();
const accessSelect = owner.locator('select[aria-label="General access"]');
await accessSelect.waitFor({ state: "visible" });
await Promise.all([
  owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"),
  accessSelect.selectOption({ label: "Anyone with the link" }),
]);
const roleSelect = owner.locator('select[aria-label="Access level for people with the link"]');
await Promise.all([
  owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"),
  roleSelect.selectOption({ label: "Editor" }),
]);
const state = await owner.evaluate(() => {
  const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const active = localStorage.getItem("mde:active");
  const d = docs.find((x) => x.id === active);
  return { d, ws: wss.find((w) => w.id === d?.workspaceId) };
});
await owner.keyboard.press("Escape").catch(() => {});
const shareUrl = `${BASE}/w/${state.ws.remoteId}/${state.d.id}/edit`;

await signIn(peer, "devon");
await peer.goto(shareUrl);
await peer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const addAsNew = peer.locator('button:has-text("Add as new workspace")');
if (await addAsNew.isVisible({ timeout: 3000 }).catch(() => false)) await addAsNew.click();
await dismissWhatsNew(peer);
await peer.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await peer.waitForTimeout(500);

await peer.click("#shareBtn");
await peer.waitForSelector('text="Only the workspace\'s owner can change who has access."', { timeout: 10000 });
await peer.waitForTimeout(300);
await peer.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await peerCtx.close();
await browser.close();
