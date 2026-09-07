import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, expectEditorContains, editorText } from "./support/collab";

test("COLLAB-43: a remote collaborator's selection renders in the other editor (yCollab awareness)", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "aware-a-e2e", "the quick brown fox jumps");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "the quick brown fox");

  // A selects "quick" (offsets 4..9) and focuses the editor.
  await a.click("#editor-mount .cm-content");
  await a.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ selection: { anchor: 4, head: 9 } });
    cm.focus();
  });

  // B's editor renders A's remote selection + caret — y-codemirror.next's
  // yRemoteSelectionsTheme (.cm-ySelection / .cm-ySelectionCaret).
  await expect(b.locator(".cm-ySelectionCaret")).toBeVisible({ timeout: 10000 });
  await expect(b.locator(".cm-ySelection").first()).toBeVisible();

  await aCtx.close();
  await bCtx.close();
});

test("COLLAB-44: a dropped WebSocket reconnects and re-syncs without duplicating content", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "reconnect-a-e2e", "START");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "START");

  // Drop B's connection — the WebSocket closes, ws.onclose -> scheduleReconnect.
  await bCtx.setOffline(true);
  await b.waitForTimeout(1500);

  // A keeps editing while B is offline.
  await a.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: " / while-offline" } });
  });

  // B comes back — reconnect (1s base backoff) then re-sync.
  await bCtx.setOffline(false);
  await expectEditorContains(b, "while-offline", 20000);

  // No duplication on either side, and the two converge.
  await expect.poll(async () => (await editorText(a)) === (await editorText(b))).toBe(true);
  const text = await editorText(b);
  expect(text.match(/START/g)?.length).toBe(1);
  expect(text.match(/while-offline/g)?.length).toBe(1);

  await aCtx.close();
  await bCtx.close();
});
