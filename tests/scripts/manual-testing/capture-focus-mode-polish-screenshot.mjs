// One-off script to capture the What's New screenshot for
// "Work Below Your Role, and a Calmer Focus Mode"
// (client/public/whats-new/focus-mode-polish.png) — shows the desktop
// focus-mode exit hint and the preview pane's paragraph dimming.
// Not part of the test suite — run manually against a wrangler dev
// instance (no dev-login needed, focus mode is a local feature):
//   npm run build && npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-focus-mode-polish-screenshot.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/focus-mode-polish.png";

async function dismissWhatsNew(page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const page = await ctx.newPage();

await page.goto(BASE);
await page.evaluate(() => {
  const now = Date.now();
  localStorage.setItem(
    "mde:docs",
    JSON.stringify([{ id: "shot-doc", name: "Weekly Notes", content: "", createdAt: now, updatedAt: now, workspaceId: "shot-ws" }]),
  );
  localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "shot-ws", name: "Local", createdAt: now, updatedAt: now }]));
  localStorage.setItem("mde:active", "shot-doc");
  localStorage.setItem("mde:activeWorkspace", "shot-ws");
  localStorage.setItem("mde:whatsNewSeen", "999.999.999");
});
await page.goto(`${BASE}/d/shot-doc`);
await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
await dismissWhatsNew(page);

// Type the sample content while the editor is visible.
await page.click("#editor-mount .cm-content");
const BODY =
  "# Weekly Notes\n\n" +
  "The quarterly review is scheduled for Thursday. Everyone should bring their own metrics and a short list of what slipped.\n\n" +
  "Focus mode keeps the paragraph you are in sharp and eases everything else back — in the editor and, now, in the preview pane too.\n\n" +
  "Draft the summary email once the numbers are final, then send it to the wider group.";
await page.evaluate((text) => {
  const view = window.MDE.getEditor();
  view.dispatch({ changes: { from: 0, insert: text } });
  // Cursor into the third paragraph ("Focus mode keeps ...").
  view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 10 } });
}, BODY);

// Collapse the sidebar first so focus mode's slide-left doesn't clip the
// wide preview pane.
await page.evaluate(() => window.MDE.toggleSidebar?.());

// Preview-only view (turn the editor pane off) — the shot is about the
// preview pane's new dimming plus the desktop exit hint; the editor's
// own (older) dimming is covered in the entry text.
await page.click("#viewMenuBtn");
await page.click('#viewMenu >> text="Editor pane"');
await page.keyboard.press("Escape").catch(() => {});

await page.click("#viewMenuBtn");
await page.click('#viewMenu >> text="Focus Mode"');
await page.waitForSelector("body.focus-mode");
await page.waitForSelector("#preview .focus-dim");

// Nudge the pointer to the top edge so the exit hint is showing.
await page.mouse.move(550, 4);
await page.waitForSelector("#focusHint.is-visible");
await page.waitForTimeout(300);

await page.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);

await ctx.close();
await browser.close();
