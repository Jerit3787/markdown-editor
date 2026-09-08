// One-off: capture client/public/whats-new/turnstile.png — the
// "Just checking you're human" prompt an anonymous visitor sees before a
// link-shared workspace loads.
//
// The prompt only renders when the client was built with
// VITE_TURNSTILE_SITE_KEY. Use a REAL Turnstile site key (the public
// half — safe to build with), not a Cloudflare test key: every test key
// stamps a red "For testing only — report to site owner" banner across
// the widget, which must not appear in a shipped screenshot. Only the
// site key is needed here; the token is never exchanged, so no
// TURNSTILE_SECRET_KEY / .dev.vars change is required.
//
//   bash tests/scripts/manual-testing/enable-dev-login.sh
//   VITE_TURNSTILE_SITE_KEY=<real-site-key> npm run build
//   npm run dev &                       # wait for :8787
//   node tests/scripts/manual-testing/capture-turnstile-screenshot.mjs
//   bash tests/scripts/manual-testing/disable-dev-login.sh
//   npm run build                       # plain rebuild — drop the key again
//
// Runs headed (headless: false) — Cloudflare's widget is more reliable
// with a real browser window.
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/turnstile.png";

async function signIn(page, username) {
  await page.route("**/api/auth/github/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) }),
  );
  await page.goto(`${BASE}/api/dev/login?username=${username}`);
}

const browser = await chromium.launch({ headless: false });
const ownerCtx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
const anonCtx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
const owner = await ownerCtx.newPage();
const anon = await anonCtx.newPage();

await signIn(owner, "ts-owner");
await owner.goto(BASE);
await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await owner
  .locator('button:has-text("Got it")')
  .click({ timeout: 2000 })
  .catch(() => {});
await owner.click("#emptyNewWorkspaceBtn").catch(() => {});
await owner.keyboard.press("Escape").catch(() => {});
await owner.evaluate(() => window.MDE.newDoc());
await owner.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await owner.click("#editor-mount .cm-content");
await owner.keyboard.type("# Team offsite plan\n\nShared with anyone who has the link.");

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

// Anonymous visitor opens the link — the Turnstile prompt appears.
await anon.goto(`${BASE}/w/${state.ws.remoteId}/${state.doc.id}/edit`);
await anon.waitForTimeout(2500);
// Close the first-visit What's New dialog so the prompt is unobscured.
await anon.evaluate(() => {
  document.querySelectorAll('[aria-labelledby="whatsNewTitle"] button').forEach((b) => {
    if (/got it/i.test(b.textContent) || b.classList.contains("modal-close-btn")) b.click();
  });
});
await anon.waitForTimeout(500);
for (let i = 0; i < 15; i++) {
  const ready = await anon.evaluate(() => {
    const w = document.querySelector("#turnstile-widget");
    return !!w && !!w.querySelector("iframe, div > div");
  });
  if (ready) break;
  await anon.waitForTimeout(700);
}
await anon.waitForTimeout(2000);
const box = await anon.locator("[aria-labelledby=turnstilePromptTitle]").boundingBox();
await anon.screenshot({
  path: OUT,
  clip: { x: Math.max(0, box.x - 28), y: Math.max(0, box.y - 28), width: box.width + 56, height: box.height + 56 },
});
console.log(`Saved ${OUT}`);

await ownerCtx.close();
await anonCtx.close();
await browser.close();
