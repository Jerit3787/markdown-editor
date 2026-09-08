// One-off: capture client/public/whats-new/mode-announce.png — a
// collaborator switches to Suggesting and the "You're now suggesting"
// toast is on screen.
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-mode-announce-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/mode-announce.png";

const browser = await chromium.launch();
const ownerCtx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const editorCtx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const owner = await ownerCtx.newPage();
const editor = await editorCtx.newPage();

async function signIn(page, username) {
  await page.route("**/api/auth/github/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) }),
  );
  await page.goto(`${BASE}/api/dev/login?username=${username}`);
}
async function dismissWhatsNew(page) {
  const b = page.locator('button:has-text("Got it")');
  if (await b.isVisible({ timeout: 2000 }).catch(() => false)) await b.click();
}

await signIn(owner, "ma-owner");
await signIn(editor, "ma-editor");

await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(owner);
await owner.click("#emptyNewWorkspaceBtn").catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Launch plan\n\nFeedback welcome before Thursday.");

await owner.click('button:has-text("Share")');
await owner
  .locator('button:has-text("Continue")')
  .click({ timeout: 2000 })
  .catch(() => {});
await owner.locator('select[aria-label="General access"]').selectOption({ label: "Anyone with the link" });
await owner.locator('select[aria-label="Access level for people with the link"]').selectOption({ label: "Editor" });
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

await editor.goto(`${BASE}/w/${state.ws.remoteId}/${state.doc.id}/edit`);
await editor.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const join = editor.locator('button:has-text("Add as new workspace")');
if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click();
await dismissWhatsNew(editor);
await editor.waitForFunction(() => (window.MDE.getEditor()?.state?.doc?.toString() ?? "").includes("Launch plan"), { timeout: 15000 });

// Switch to Suggesting → the toast appears; capture within its 3.2s life.
await editor.click(".mode-switcher-btn");
await editor.click('.mode-switcher-menu [role="menuitem"]:has-text("Suggesting")');
await editor.locator('.toast:has-text("You\'re now suggesting")').waitFor({ timeout: 3000 });
await editor.waitForTimeout(250);
await editor.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await editorCtx.close();
await browser.close();
