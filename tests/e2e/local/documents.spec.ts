import { test, expect } from "./support/fixtures";

test("app loads and shows the seeded document", async ({ page, docId }) => {
  await expect(page.locator("#docList li.active .doc-name")).toHaveText("E2E Test Doc");
  await expect(page.locator("#editor-mount .cm-content")).toBeVisible();
  const docsInStorage = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]"));
  expect(docsInStorage).toHaveLength(1);
  expect(docsInStorage[0].id).toBe(docId);
});

test("typing in the editor updates the doc content", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("hello world");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("hello world");
});

test("creating a new document adds it to the sidebar and switches to it", async ({ page }) => {
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length);
  await page.evaluate(() => window.MDE.newDoc());
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").length)).toBe(before + 1);
});

test("DOC-04: deleting the active document via the row menu (confirmed) removes it and falls back to a sibling", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "e2e-doc-b", name: "Doc B" });
    switchDoc("e2e-doc-1");
  });
  await page.locator('#docList li:has(.doc-row-link[href="/d/e2e-doc-1"]) .doc-menu-btn').click();
  await page.locator('.doc-menu-popover button.danger:has-text("Delete")').click();
  await page.locator('button.primary-btn:has-text("Delete")').click();

  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { id: string }) => d.id)))
    .not.toContain("e2e-doc-1");
  await expect(page.locator("#editor-mount .cm-content")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("mde:active"))).toBe("e2e-doc-b");
});

test("DOC-07: moving a document to another workspace via the row menu reassigns it", async ({ page }) => {
  await page.evaluate(async () => {
    const { createWorkspace, switchWorkspace } = await import("/src/stores/workspaces.ts");
    createWorkspace("Second WS"); // createWorkspace activates the new one
    switchWorkspace("e2e-ws-1"); // back to where e2e-doc-1 lives
  });
  await page.locator('#docList li:has(.doc-row-link[href="/d/e2e-doc-1"]) .doc-menu-btn').click();
  await page.locator('.doc-menu-popover button:has-text("Move")').click();
  await page.locator('.modal-box-v2 button:has-text("Move")').first().click();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
        const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
        const doc = docs.find((d: { id: string }) => d.id === "e2e-doc-1");
        const target = wss.find((w: { name: string }) => w.name === "Second WS");
        return doc?.workspaceId === target?.id;
      }),
    )
    .toBe(true);
});
