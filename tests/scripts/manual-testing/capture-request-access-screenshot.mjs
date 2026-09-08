// One-off script to capture the What's New screenshot for CV2-5
// (client/public/whats-new/request-access.png) — the owner's Share dialog
// with a pending request row.
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-request-access-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/request-access.png";

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
const ownerCtx = await browser.newContext({ viewport: { width: 1000, height: 720 } });
const viewerCtx = await browser.newContext({ viewport: { width: 1000, height: 720 } });
const owner = await ownerCtx.newPage();
const viewer = await viewerCtx.newPage();

await signIn(owner, "ra-owner");
await signIn(viewer, "ra-viewer");

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn").catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Q3 Planning\n\nRough notes — feedback welcome before Friday.");

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

// Viewer joins and requests edit access.
await viewer.goto(`${BASE}/w/${state.ws.remoteId}/${state.doc.id}/edit`);
await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const join = viewer.locator('button:has-text("Add as new workspace")');
if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click();
await dismissWhatsNew(viewer);
await viewer.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Q3 Planning"), { timeout: 15000 });
await viewer.locator("#shareBtn").click();
await viewer.getByLabel("Add a note to the owner (optional)").fill("I spotted a couple of typos I could fix.");
await viewer.getByRole("button", { name: "Send request" }).click();

// Owner opens Share → the Requests section.
await owner.waitForTimeout(1000);
await owner.locator("#shareBtn").click();
await owner.getByText("Requests").waitFor();
await owner.waitForTimeout(400);

await owner.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await viewerCtx.close();
await browser.close();
