// One-off script to capture the What's New screenshot for suggestion-mode
// collaboration (client/public/whats-new/suggestion-mode-collaboration.png).
// Not part of the test suite — run manually against a wrangler dev instance
// with the dev-login route applied (see enable-dev-login.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/suggestion-mode-collaboration.png";

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
const reviewerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
await owner.keyboard.type("# Q3 Roadmap\n\nShip the new onboarding flow and update the pricing page before the end of the quarter.");

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
  const activeId = localStorage.getItem("mde:active");
  const activeDoc = docs.find((d) => d.id === activeId);
  const ws = workspaces.find((w) => w.id === activeDoc?.workspaceId);
  return { activeDoc, ws };
});
const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;
const doneBtn = owner.locator('button:has-text("Done")');
if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
await owner.keyboard.press("Escape").catch(() => {});

await reviewer.goto(shareUrl);
await reviewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const joinModal = reviewer.locator('text="Join shared workspace"');
if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) await reviewer.click('button:has-text("Add as new workspace")');
await dismissWhatsNew(reviewer);

await reviewer.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Q3 Roadmap"), { timeout: 15000 });

// Reviewer proposes an insertion...
await reviewer.click("#editor-mount .cm-content");
await reviewer.keyboard.press("Control+End");
await reviewer.keyboard.insertText(" We should also refresh the onboarding illustrations.");

// ...and a deletion.
await reviewer.keyboard.press("Control+Home");
for (let i = 0; i < 2; i++) await reviewer.keyboard.press("ArrowDown");
await reviewer.keyboard.press("Home");
await reviewer.keyboard.down("Shift");
for (let i = 0; i < 4; i++) await reviewer.keyboard.press("ArrowRight");
await reviewer.keyboard.up("Shift");
await reviewer.keyboard.press("Backspace");

await owner.waitForSelector(".cm-suggestion-insert", { timeout: 15000 });
await owner.waitForSelector(".cm-suggestion-delete", { timeout: 15000 });
await owner.waitForSelector("#preview .suggestion-insert", { timeout: 15000 });
await owner.waitForSelector("#preview .suggestion-delete", { timeout: 15000 });
// Let the "invited"/"access set to" toasts (3.2s auto-dismiss) clear
// before capturing, so the screenshot isn't cluttered with them.
await owner.waitForTimeout(3800);

await owner.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await reviewerCtx.close();
await browser.close();
