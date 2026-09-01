// One-off script to capture the What's New screenshot for shared-workspace
// previews (client/public/whats-new/shared-workspace-preview.png). Not part
// of the test suite — run manually against a wrangler dev instance with the
// dev-login route applied (see enable-dev-login.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/shared-workspace-preview.png";

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
const aliceCtx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const bobCtx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const alice = await aliceCtx.newPage();
const bob = await bobCtx.newPage();

await signIn(alice, "shot-alice");
await signIn(bob, "shot-bob");

// Alice: create and share a single document.
await alice.goto(BASE);
await alice.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(alice);
await alice.click("#emptyNewWorkspaceBtn");
await alice.keyboard.press("Escape").catch(() => {});
await alice.evaluate(() => window.MDE.newDoc());
await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await alice.click("#editor-mount .cm-content");
await alice.keyboard.type("# Q3 Roadmap\n\nDraft for review before the planning meeting.");

await alice.click('button:has-text("Share")');
const moveDialog = alice.locator('button:has-text("Continue")');
if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
const accessSelect = alice.locator("select").first();
await accessSelect.waitFor({ state: "visible" });
await Promise.all([
  alice.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
  accessSelect.selectOption({ label: "Anyone with the link" }),
]);
const shareState = await alice.evaluate(() => {
  const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const activeId = localStorage.getItem("mde:active");
  const activeDoc = docs.find((d) => d.id === activeId);
  const ws = workspaces.find((w) => w.id === activeDoc?.workspaceId);
  return { activeDoc, ws };
});
const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;
const doneBtn = alice.locator('button:has-text("Done")');
if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
await alice.keyboard.press("Escape").catch(() => {});

// Bob already has a workspace of his own — this is what makes the
// single-doc auto-join land as a preview instead of committing
// permanently.
await bob.goto(BASE);
await bob.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(bob);
await bob.click("#emptyNewWorkspaceBtn");
await bob.keyboard.press("Escape").catch(() => {});

await bob.goto(shareUrl);
await bob.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await bob.waitForSelector(".workspace-preview-badge", { timeout: 15000 });

// Open the switcher so the Preview badge and Keep action are both visible.
await bob.click(".workspace-switcher-trigger");
await bob.waitForSelector('button:has-text("Keep this workspace")', { timeout: 5000 });

await bob.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await aliceCtx.close();
await bobCtx.close();
await browser.close();
