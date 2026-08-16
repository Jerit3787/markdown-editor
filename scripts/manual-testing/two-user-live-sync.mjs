// Manual end-to-end test for workspace-level sharing, using two fully
// independent Playwright browser contexts (separate cookie jars) to
// simulate two real collaborators — signed in via the local-only
// /api/dev/login route (see scripts/manual-testing/README.md), not real
// GitHub OAuth. Run against `npm run dev` on localhost:8787.
//
// Usage: node scripts/manual-testing/two-user-live-sync.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:8787";

function log(who, msg) {
  console.log(`[${who}] ${msg}`);
}

async function dismissWhatsNew(page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await gotIt.click();
    await page.waitForTimeout(200);
  }
}

// The real /api/auth/github/me now actively re-verifies the session
// token against GitHub's own API (a recent, unrelated fix) — a fake
// dev-login token correctly fails that check, which would otherwise
// block every Share-gated flow behind a real GitHub sign-in this test
// has no way to provide. Some of those flows (collab.ts's own
// joinSharedLink, run at page-load time) fire before a post-navigation
// page.evaluate() stub could land, so this intercepts the underlying
// HTTP call itself instead — same effect, no timing race, and no
// source file touched.
async function stubGithubIdentity(page, username) {
  await page.route("**/api/auth/github/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) })
  );
}

(async () => {
  const browser = await chromium.launch();
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  alice.on("console", (m) => log("alice console", m.text()));
  bob.on("console", (m) => log("bob console", m.text()));
  alice.on("pageerror", (e) => log("alice PAGEERROR", e.message));
  bob.on("pageerror", (e) => log("bob PAGEERROR", e.message));
  alice.on("response", (r) => {
    if (!r.ok() && r.status() !== 304) log("alice net", `${r.status()} ${r.url()}`);
  });
  bob.on("response", (r) => {
    if (!r.ok() && r.status() !== 304) log("bob net", `${r.status()} ${r.url()}`);
  });

  // --- Sign in both, independently ---
  await stubGithubIdentity(alice, "alice-pw");
  await stubGithubIdentity(bob, "bob-pw");
  await alice.goto(`${BASE}/api/dev/login?username=alice-pw`);
  await bob.goto(`${BASE}/api/dev/login?username=bob-pw`);

  // --- Alice: fresh doc, real content, share it ---
  await alice.goto(BASE);
  await alice.waitForFunction(() => window.MDE && typeof window.MDE.setView === "function", { timeout: 15000 });
  await alice.waitForTimeout(500);
  await dismissWhatsNew(alice);
  await alice.evaluate(() => window.MDE.setView("split"));
  // A brand-new session (fresh localStorage from a fresh browser context)
  // starts with zero documents — the empty/"Welcome" state inline-hides
  // #editorPane until a real document exists, overriding any CSS class.
  // newDoc() must run before waiting for the pane to become visible.
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible", timeout: 15000 });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("PLAYWRIGHT TEST content that must sync live to bob");
  await alice.waitForTimeout(300);

  const editorText = await alice.evaluate(() => window.MDE.getEditor().state.doc.toString());
  log("alice", `editor content before share: ${JSON.stringify(editorText)}`);

  await alice.click('button:has-text("Share")');
  await alice.waitForTimeout(800);
  const moveDialog = alice.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible().catch(() => false)) {
    await moveDialog.click();
    log("alice", "confirmed move-to-own-workspace dialog");
    // openShareModal() opens the Share modal itself right after the
    // confirm resolves — no second click needed.
  }

  const accessSelect = alice.locator("select").first();
  await accessSelect.waitFor({ state: "visible", timeout: 5000 });
  await accessSelect.selectOption({ label: "Anyone with the link" });
  await alice.waitForTimeout(800);

  const shareState = await alice.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d) => d.id === activeId);
    const ws = workspaces.find((w) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  log("alice", `share state: ${JSON.stringify(shareState)}`);

  if (!shareState.ws || !shareState.ws.shared) {
    log("alice", "ERROR: workspace not marked shared, aborting");
    await browser.close();
    process.exit(1);
  }

  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${shareState.activeDoc.id}/edit`;
  log("test", `share URL: ${shareUrl}`);

  // Close the Share modal — it's still open and its dropdown overlay
  // would otherwise intercept the later click into the editor.
  const doneBtn = alice.locator('button:has-text("Done")');
  if (await doneBtn.isVisible().catch(() => false)) await doneBtn.click();
  await alice.keyboard.press("Escape").catch(() => {});

  // Give alice's client a moment to finish its own seed+connect handshake.
  await alice.waitForTimeout(1500);

  // --- Bob: open the share link ---
  await bob.goto(shareUrl);
  await bob.waitForFunction(() => window.MDE && typeof window.MDE.setView === "function", { timeout: 15000 });
  await bob.waitForTimeout(1500);

  // The join-workspace modal and the What's New modal can both want to
  // render on a first-ever visit — handle whichever is actually on top
  // first, since a covered "Got it" isn't clickable.
  const bobJoinModalVisible = await bob.locator('text="Join shared workspace"').isVisible().catch(() => false);
  log("bob", `join modal visible: ${bobJoinModalVisible}`);

  if (bobJoinModalVisible) {
    await bob.click('button:has-text("Add as new workspace")');
    await bob.waitForTimeout(1500);
    await dismissWhatsNew(bob);
  } else {
    await dismissWhatsNew(bob);
  }
  await bob.evaluate(() => window.MDE.setView("split")).catch(() => {});
  await bob.waitForTimeout(500);

  const bobEditorText = await bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "<no editor>");
  log("bob", `editor content after join: ${JSON.stringify(bobEditorText)}`);

  // --- Live sync check: alice types more, does bob see it without reload? ---
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.press("End");
  await alice.keyboard.type(" [LIVE APPEND]");
  await alice.waitForTimeout(1500);

  const bobEditorTextAfterLiveEdit = await bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "<no editor>");
  log("bob", `editor content after alice's live edit (no reload): ${JSON.stringify(bobEditorTextAfterLiveEdit)}`);

  const pass = bobEditorTextAfterLiveEdit.includes("PLAYWRIGHT TEST content") && bobEditorTextAfterLiveEdit.includes("[LIVE APPEND]");
  log("test", pass ? "PASS: bob received alice's seeded content AND her live edit" : "FAIL: content did not fully sync to bob");

  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
