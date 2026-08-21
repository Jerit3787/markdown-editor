// Diagnoses editor<->preview scroll-sync/cursor-follow behavior against
// a real document (scroll-sync-fixture.md by default) on a running instance
// (production by default). Loads the file content directly into the
// editor via window.MDE, then at several cursor positions throughout
// the document checks how far the preview's actual content is from
// where followCursorInPreview() put it.
//
// Usage: node scripts/manual-testing/scroll-sync-repro.mjs [url] [file]
import { chromium } from "playwright";
import { readFileSync } from "fs";

const URL = process.argv[2] || "https://editor.danplace.tech";
const FILE = process.argv[3] || "scroll-sync-fixture.md";
const content = readFileSync(FILE, "utf8");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

  await page.goto(URL);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.newDoc === "function", { timeout: 15000 });
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
  await page.evaluate(() => window.MDE.setView("split"));
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible", timeout: 15000 });

  // Load the real content directly, bypassing any file-picker UI.
  await page.evaluate((text) => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });
  }, content);
  await page.waitForTimeout(500);

  const totalLines = await page.evaluate(() => window.MDE.getEditor().state.doc.lines);
  console.log(`Loaded ${FILE}: ${totalLines} lines`);

  // Walk the document in steps, placing the cursor at the start of each
  // sampled line (as if the user clicked there to type), and check
  // whether the preview's on-screen content actually corresponds to
  // that line — not just whether some scroll happened.
  const step = Math.max(1, Math.floor(totalLines / 20));
  for (let line = 1; line <= totalLines; line += step) {
    const result = await page.evaluate((ln) => {
      const cm = window.MDE.getEditor();
      const linePos = cm.state.doc.line(ln).from;
      cm.dispatch({ selection: { anchor: linePos } });
      // Force the update listener's followCursorInPreview() to run —
      // a selection dispatch already triggers it via update.selectionSet,
      // this just waits a tick for the scroll to land.
      return new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const preview = document.getElementById("preview");
            // Find the tagged preview block whose line range brackets `ln`
            // (0-indexed data-line vs 1-indexed `ln` from doc.line()).
            const blocks = Array.from(preview.querySelectorAll("[data-line]"))
              .map((el) => ({ el, line: Number(el.getAttribute("data-line")) }))
              .sort((a, b) => a.line - b.line);
            let match = null;
            for (const b of blocks) {
              if (b.line <= ln - 1) match = b;
              else break;
            }
            const preRect = preview.getBoundingClientRect();
            const elRect = match ? match.el.getBoundingClientRect() : null;
            const visible = elRect ? elRect.bottom > preRect.top && elRect.top < preRect.bottom : false;
            return resolve({
              previewScrollTop: preview.scrollTop,
              matchedBlockLine: match ? match.line : null,
              matchedBlockVisible: visible,
              matchedBlockTopRelativeToViewport: elRect ? Math.round(elRect.top - preRect.top) : null,
            });
          }),
        );
      });
    }, line);
    console.log(`line ${line}/${totalLines}:`, JSON.stringify(result));
  }

  await browser.close();
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
