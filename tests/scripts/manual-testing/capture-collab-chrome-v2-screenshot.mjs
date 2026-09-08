// One-off script to capture the What's New screenshot for
// "A Clearer View-Only Mode" (client/public/whats-new/collab-chrome-v2.png).
// Run against a wrangler dev instance with the dev-login route applied:
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-collab-chrome-v2-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/collab-chrome-v2.png";

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

const browser = await chromium.launch();
const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const viewerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const owner = await ownerCtx.newPage();
const viewer = await viewerCtx.newPage();

await signIn(owner, "cv2-owner");
await signIn(viewer, "cv2-viewer");

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn").catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Team Handbook\n\nThis section is still being drafted — check back after Friday's review.");

// Share the workspace read-only (anyone-with-link → Viewer).
await owner.click('button:has-text("Share")');
await owner
  .locator('button:has-text("Continue")')
  .click({ timeout: 2000 })
  .catch(() => {});
await owner.locator('select[aria-label="General access"]').selectOption({ label: "Anyone with the link" });
await owner.locator('select[aria-label="Access level for people with the link"]').selectOption({ label: "Viewer" });
const state = await owner.evaluate(() => {
  const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
  const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  const activeId = localStorage.getItem("mde:active");
  const doc = docs.find((d) => d.id === activeId);
  return { doc, ws: wss.find((w) => w.id === doc?.workspaceId) };
});
await owner
  .locator('button:has-text("Done")')
  .click({ timeout: 2000 })
  .catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});

// Viewer joins.
await viewer.goto(`${BASE}/w/${state.ws.remoteId}/${state.doc.id}/edit`);
await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const join = viewer.locator('button:has-text("Add as new workspace")');
if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click();
await dismissWhatsNew(viewer);
await viewer.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Team Handbook"), { timeout: 15000 });

// Open the condensed Edit menu.
await viewer.click("#editMenuBtn");
await viewer.waitForSelector("#editMenu #menuFind");
await viewer.waitForTimeout(400);

await viewer.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await viewerCtx.close();
await browser.close();
