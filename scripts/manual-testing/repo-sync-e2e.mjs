// Manual E2E for GitHub repo sync — requires a REAL GitHub repo you can
// push test commits to (this creates and deletes files in it) and a real
// GitHub OAuth session. Unlike the workspace-sharing scripts in this
// directory, the dev-login route's fake session cookie does NOT work
// here: /api/auth/github/me actively re-verifies the token against
// GitHub's real API and reports granted scopes, and repo-sync gates
// every action on scopes.includes("repo") — a fake token fails that
// check immediately. Sign in through the actual GitHub OAuth popup when
// the script pauses for it.
//
// Usage: node scripts/manual-testing/repo-sync-e2e.mjs <owner>/<repo> [url]
import { chromium } from "playwright";

const [ownerRepo, url = "http://localhost:8787"] = process.argv.slice(2);
if (!ownerRepo || !ownerRepo.includes("/")) {
  console.error("Usage: node repo-sync-e2e.mjs <owner>/<repo> [url]");
  process.exit(1);
}
const [owner, repo] = ownerRepo.split("/");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

  await page.goto(url);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.newDoc === "function", { timeout: 15000 });
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();

  console.log("Sign in with GitHub in the opened window if prompted, then press Enter here to continue.");
  await new Promise((resolve) => process.stdin.once("data", resolve));

  await page.evaluate(() => window.MDE.setView("split"));
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible", timeout: 15000 });
  await page.evaluate((text) => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });
  }, "# Test doc\n\nCreated by repo-sync-e2e.mjs.");

  await page.evaluate(() => window.MDE.openRepoLinkModal?.());
  await page.waitForSelector('input[aria-label="owner/repo"]', { state: "visible", timeout: 5000 });
  await page.fill('input[aria-label="owner/repo"]', `${owner}/${repo}`);
  await page.click('input[aria-label="owner/repo"] ~ button');
  console.log(`Linked to ${owner}/${repo}. Pushing...`);

  await page.evaluate(() => window.MDE.pushToRepoAction?.());
  await page.waitForTimeout(2000);
  console.log(`Check https://github.com/${owner}/${repo}/commits to verify a new commit landed.`);

  await browser.close();
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
