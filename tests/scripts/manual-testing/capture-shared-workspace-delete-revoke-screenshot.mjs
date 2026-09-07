// One-off script to capture the What's New screenshot for
// "Deleting a Shared Workspace Revokes Access"
// (client/public/whats-new/shared-workspace-delete-revoke.png).
// Not part of the test suite — run manually against a wrangler dev
// instance with the dev-login route applied (see enable-dev-login.sh):
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-shared-workspace-delete-revoke-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/shared-workspace-delete-revoke.png";

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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await ctx.newPage();

await signIn(page, "shot-del-owner");
await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await dismissWhatsNew(page);

await page.click("#emptyNewWorkspaceBtn");
await page.keyboard.press("Escape").catch(() => {});
await page.evaluate(() => window.MDE.newDoc());
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await page.click("#editor-mount .cm-content");
await page.keyboard.type("# Q3 Planning\n\nShared with the whole team.");

// Name the workspace so the dialog reads naturally.
await page.click("#workspace-switcher-mount .workspace-switcher-trigger");
await page.click('#workspace-switcher-mount .workspace-row button[aria-label="Rename workspace"]');
const nameInput = page.locator("#workspace-switcher-mount .workspace-rename-input");
await nameInput.fill("Q3 Planning");
await nameInput.press("Enter");

// Share it (Anyone with the link) so it's a real shared workspace.
await page.click('button:has-text("Share")');
const moveDialog = page.locator('button:has-text("Continue")');
if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
const accessSelect = page.locator('select[aria-label="General access"]');
await accessSelect.waitFor({ state: "visible" });
await Promise.all([
  page.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
  accessSelect.selectOption({ label: "Anyone with the link" }),
]);
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(3600); // let the "link access" toast (3.2s) auto-dismiss

// Open the switcher and trigger delete — capture the confirm dialog.
await page.click("#workspace-switcher-mount .workspace-switcher-trigger");
await page.click('#workspace-switcher-mount .workspace-row button[aria-label="Delete workspace"]');
await page.waitForSelector("text=revokes access for everyone", { timeout: 10000 });
await page.waitForTimeout(300);

await page.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ctx.close();
await browser.close();
