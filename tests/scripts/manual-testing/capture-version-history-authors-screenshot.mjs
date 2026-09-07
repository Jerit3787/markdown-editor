// One-off: captures the What's New screenshot for Version History author
// avatars (client/public/whats-new/version-history-authors.png). Not part
// of the test suite — run manually against a wrangler dev instance with
// the dev-login route applied (see enable-dev-login.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/version-history-authors.png";

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
await owner.click("#docTitle");
await owner.fill("#docTitle", "Team Handbook");
await owner.keyboard.press("Enter");

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
  owner.locator('select[aria-label="Access level for people with the link"]').selectOption({ label: "Editor" }),
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

// maria edits (snapshot #1 -> maria). Wait past the 30s throttle, then
// devon edits (snapshot #2 -> devon), so two rows show two people.
await owner.evaluate(() => {
  const cm = window.MDE.getEditor();
  cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "# Team Handbook\n\nOnboarding, tooling, and norms." } });
});
await peer.waitForTimeout(1500);
await new Promise((r) => setTimeout(r, 31_000));
await peer.evaluate(() => {
  const cm = window.MDE.getEditor();
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: "\n\n## Code review\n\nTwo approvals to merge." } });
});
await peer.waitForTimeout(1500);
await owner.evaluate(() => {
  const cm = window.MDE.getEditor();
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: "\n" } });
});
await peer.waitForTimeout(2500);

await peer.click("#versionHistoryBtn");
await peer.waitForSelector(".version-history-authors", { timeout: 10000 });
// Expand the session so the per-version rows (short labels, one avatar
// each) show alongside the session header's union.
await peer.click(".version-history-session-header");
await peer.waitForSelector(".version-history-nested-row", { timeout: 5000 });
await peer.waitForTimeout(400);
await peer.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await peerCtx.close();
await browser.close();
