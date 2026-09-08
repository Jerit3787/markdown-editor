// One-off script to capture the What's New screenshot for
// "Links Between Documents, and Safer Code Samples"
// (client/public/whats-new/preview-links.png).
// Not part of the test suite — run manually against a wrangler dev
// instance (no dev-login needed):
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-preview-links-screenshot.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/preview-links.png";

async function dismissWhatsNew(page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const page = await ctx.newPage();

await page.goto(BASE);
await page.evaluate(() => {
  const now = Date.now();
  localStorage.setItem(
    "mde:docs",
    JSON.stringify([
      { id: "pl-readme", name: "Weekly Notes", content: "", createdAt: now, updatedAt: now, workspaceId: "pl-ws" },
      { id: "pl-design", name: "Design Notes", content: "# Design Notes\n", createdAt: now, updatedAt: now, workspaceId: "pl-ws" },
    ]),
  );
  localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "pl-ws", name: "Local", createdAt: now, updatedAt: now }]));
  localStorage.setItem("mde:active", "pl-readme");
  localStorage.setItem("mde:activeWorkspace", "pl-ws");
  localStorage.setItem("mde:whatsNewSeen", "999.999.999");
});
await page.goto(`${BASE}/d/pl-readme`);
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await dismissWhatsNew(page);

await page.click("#editor-mount .cm-content");
await page.evaluate((text) => {
  window.MDE.getEditor().dispatch({ changes: { from: 0, insert: text } });
}, "# Weekly Notes\n\nSee the [Design Notes](Design%20Notes) for background — a plain\nmarkdown link to another document now opens it.\n\nAn unresolved one like [old plan](Archived%20Plan) shows a dashed style.\n\nConfig key: `[[legacy]]` is left exactly as written inside code.\n");

// Default view is split (editor + preview both visible) — no menu changes.
await page.waitForSelector("#preview a.wikilink");
await page.waitForSelector("#preview a.doc-ref-missing");
await page.waitForSelector("#preview code");
await page.waitForTimeout(300);

await page.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ctx.close();
await browser.close();
