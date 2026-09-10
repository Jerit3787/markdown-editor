// One-off: captures the What's New screenshot for suggestion line-grouping
// (client/public/whats-new/suggestion-line-grouping.png) — several small
// pending suggestions on one line collapsed into a single rail card with a
// row per change.
//
// Not part of the test suite — run manually against a wrangler dev
// instance with the dev-login route applied (see enable-dev-login.sh):
//
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npx wrangler dev --local-upstream localhost:8787 &
//   node tests/scripts/manual-testing/capture-suggestion-line-grouping-screenshot.mjs
//   kill %1; bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/suggestion-line-grouping.png";
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
const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const reviewerCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const owner = await ownerCtx.newPage();
const reviewer = await reviewerCtx.newPage();

await signIn(owner, "lg-shot-owner");
await signIn(reviewer, "lg-shot-reviewer");

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn");
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Release notes draft\n\nThe update ships on Thursday to every workspace on the plan.");

await owner.click('button:has-text("Share")');
const addPeople = owner.locator('input[aria-label="Add people by GitHub username"]');
const cont = owner.locator('button:has-text("Continue")');
if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) await cont.click();
await addPeople.waitFor({ state: "visible" });
await addPeople.fill("lg-shot-reviewer");
await Promise.all([owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"), addPeople.press("Enter")]);
await Promise.all([
  owner.waitForResponse((r) => /\/api\/workspace\/[^/]+\/access$/.test(r.url()) && r.request().method() === "PUT"),
  owner.locator('select[aria-label="Access level for lg-shot-reviewer"]').selectOption({ label: "Reviewer" }),
]);
const state = await owner.evaluate(() => {
  const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const d = docs.find((x) => x.id === localStorage.getItem("mde:active"));
  return { d, ws: wss.find((w) => w.id === d?.workspaceId) };
});
await owner.keyboard.press("Escape").catch(() => {});
const shareUrl = `${BASE}/w/${state.ws.remoteId}/${state.d.id}/edit`;

await reviewer.goto(shareUrl);
await reviewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const addAsNew = reviewer.locator('button:has-text("Add as new workspace"), button:has-text("Keep this workspace")').first();
if (await addAsNew.isVisible({ timeout: 3000 }).catch(() => false)) await addAsNew.click();
await dismissWhatsNew(reviewer);
await reviewer.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("ships on Thursday"), { timeout: 15000 });

// Three separate edits on the one sentence line — unchanged text between
// each so the contiguous-extend never merges the suggestion entries.
await reviewer.click("#editor-mount .cm-content");
await reviewer.evaluate(() => {
  const cm = window.MDE.getEditor();
  const i = cm.state.doc.toString().indexOf("update ships") + "update ".length;
  cm.dispatch({ selection: { anchor: i } });
});
await reviewer.keyboard.insertText("quietly ");
await reviewer.evaluate(() => {
  const cm = window.MDE.getEditor();
  const i = cm.state.doc.toString().indexOf("on Thursday") + "on Thursday".length;
  cm.dispatch({ selection: { anchor: i } });
});
await reviewer.keyboard.insertText(" morning");
await reviewer.evaluate(() => {
  const cm = window.MDE.getEditor();
  cm.dispatch({ selection: { anchor: cm.state.doc.length } });
});
await reviewer.keyboard.insertText(" — details in the changelog");

await owner.waitForFunction(() => document.querySelectorAll(".cm-suggestion-insert").length >= 3, { timeout: 20000 });

await owner.click("#commentsBtn");
await owner.locator(".annotation-card.suggestion .annotation-card-subedit").first().waitFor({ state: "visible", timeout: 10000 });
await owner.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0 } }));
await owner.mouse.move(680, 400);
await owner.waitForTimeout(4000);

await owner.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await reviewerCtx.close();
await browser.close();
