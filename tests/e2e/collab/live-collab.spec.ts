import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, editorText, expectEditorContains, BASE } from "./support/collab";

test("COLLAB-13: two collaborators editing concurrently converge in both directions", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "conv-a-e2e", "MIDDLE");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "MIDDLE");

  // Both edit concurrently (A at the start, B at the end of the line).
  await a.click("#editor-mount .cm-content");
  await a.keyboard.press("ControlOrMeta+ArrowLeft");
  await a.keyboard.type("A-EDIT ");

  await b.click("#editor-mount .cm-content");
  await b.keyboard.press("ControlOrMeta+ArrowRight");
  await b.keyboard.type(" B-EDIT");

  // The CRDT converges: both edits land, on both sides, to identical text.
  await expectEditorContains(a, "A-EDIT");
  await expectEditorContains(a, "B-EDIT");
  await expectEditorContains(b, "A-EDIT");
  await expectEditorContains(b, "B-EDIT");
  await expect.poll(async () => (await editorText(a)) === (await editorText(b))).toBe(true);
  expect(await editorText(a)).toContain("MIDDLE");

  await aCtx.close();
  await bCtx.close();
});

test("COLLAB-25: a single-doc share link is received as its own new workspace named after the doc, with no join modal", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "singledoc-a-e2e", "the only document");
  const url = await shareAnyoneLink(a, "Editor");

  await b.goto(url);
  await b.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });

  // No "Join shared workspace" modal for a single-doc link — it lands
  // directly as its own new workspace (b started with none).
  await expect(b.locator('text="Join shared workspace"')).toHaveCount(0);
  await expectEditorContains(b, "the only document");

  const ws = await b.evaluate(() => {
    const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const activeWs = localStorage.getItem("mde:activeWorkspace");
    return wss.find((w: { id: string }) => w.id === activeWs) ?? null;
  });
  expect(ws).not.toBeNull();
  expect(ws.remoteId).toBeTruthy(); // linked to the shared room
  // Named for the doc, not the generic multi-doc "Shared workspace".
  expect(ws.name).not.toBe("Shared workspace");
  expect(ws.name).not.toBe("New workspace");

  await aCtx.close();
  await bCtx.close();
});
