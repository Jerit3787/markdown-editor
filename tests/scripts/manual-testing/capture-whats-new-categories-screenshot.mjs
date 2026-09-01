// One-off script to capture the What's New screenshot for this very
// feature (client/public/whats-new/categorized-whats-new.png). Not part
// of the test suite — run manually against `npm run dev:client` (plain
// Vite dev server; this feature has no Worker/collab dependency).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:5173";
const OUT = "client/public/whats-new/categorized-whats-new.png";
// page.evaluate() sends raw source over CDP, bypassing Vite's own
// __APP_VERSION__ define substitution — read the real version here in
// Node instead and pass it in as a plain string.
const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });

await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
// A truly fresh context has no localStorage at all yet, which triggers
// both the auto-open What's New popup (before we can mark ourselves
// caught up) and a "No workspace yet" onboarding dialog that would
// otherwise stack on top of our screenshot — seed a minimal doc (same
// shape as tests/e2e/local/support/fixtures.ts) plus the caught-up
// marker, then reload so the component re-evaluates cleanly.
await page.evaluate((v) => {
  const now = Date.now();
  localStorage.setItem("mde:docs", JSON.stringify([{ id: "shot-doc-1", name: "Doc", content: "", createdAt: now, updatedAt: now, workspaceId: "shot-ws-1" }]));
  localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "shot-ws-1", name: "Workspace", createdAt: now, updatedAt: now }]));
  localStorage.setItem("mde:active", "shot-doc-1");
  localStorage.setItem("mde:activeWorkspace", "shot-ws-1");
  localStorage.setItem("mde:whatsNewSeen", v);
}, version);
await page.reload();
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
await page.click("#helpMenuBtn");
await page.click('button:has-text("What\'s New")');
await page.waitForSelector("text=Editing & Formatting");
await page.waitForTimeout(500); // let the modal's own fade-in transition settle

await page.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);
await browser.close();
