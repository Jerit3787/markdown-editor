// One-off script to capture the What's New screenshot for mid-session
// document discovery (client/public/whats-new/live-mid-session-docs.png).
// Not part of the test suite — run manually against a wrangler dev instance
// with the dev-login route applied (see enable-dev-login.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/live-mid-session-docs.png";

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

async function renameActiveDoc(page, name) {
  const titleInput = page.locator("#docTitle");
  await titleInput.click();
  await titleInput.press("Control+A");
  await titleInput.type(name);
  await titleInput.press("Tab");
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const aliceCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const alice = await aliceCtx.newPage();
const bob = await bobCtx.newPage();

await signIn(alice, "shot-alice");
await signIn(bob, "shot-bob");

await alice.goto(BASE);
await alice.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(alice);
await alice.click("#emptyNewWorkspaceBtn");
await alice.keyboard.press("Escape").catch(() => {});
await alice.evaluate(() => window.MDE.newDoc());
await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await renameActiveDoc(alice, "Q3 Planning");
await alice.click("#editor-mount .cm-content");
await alice.keyboard.type("# Q3 Planning\n\nKickoff notes for the quarter.");

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

// Bob joins and fully settles on the first document before Alice ever
// creates the second one — the exact mid-session scenario this feature
// covers.
await bob.goto(shareUrl);
await bob.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const joinModal = bob.locator('text="Join shared workspace"');
if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) await bob.click('button:has-text("Add as new workspace")');
await dismissWhatsNew(bob);
await bob.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Q3 Planning"), { timeout: 15000 });

// Only now does Alice create a second document in the same workspace.
await alice.evaluate(() => window.MDE.newDoc());
await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await renameActiveDoc(alice, "Meeting Notes");
await alice.click("#editor-mount .cm-content");
await alice.keyboard.type("# Meeting Notes\n\nDiscussed the roadmap and next steps.");

const secondDocId = await alice.evaluate(() => localStorage.getItem("mde:active"));

await bob.waitForFunction((id) => JSON.parse(localStorage.getItem("mde:docs") || "[]").some((d) => d.id === id), secondDocId, { timeout: 15000 });
await bob.evaluate((id) => window.MDE.switchDoc(id), secondDocId);
await bob.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Meeting Notes"), { timeout: 15000 });

// Let the "invited"/"access set to" toasts (3.2s auto-dismiss) clear
// before capturing, so the screenshot isn't cluttered with them.
await bob.waitForTimeout(3800);

await bob.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await aliceCtx.close();
await bobCtx.close();
await browser.close();
