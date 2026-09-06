import { test, expect } from "./support/fixtures";

// Two Playwright pages from the same `context` share one localStorage
// partition — a faithful stand-in for two browser tabs on the same
// origin. `persistDocs` / `persistWorkspaces` merge by record + updatedAt
// on every save (the multi-tab data-loss fix), so a save in one tab must
// never clobber another tab's untouched documents.

test("DOC-15: a save in one tab never clobbers another tab's untouched documents", async ({ page, context }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "tabdoc2", name: "Tab Doc 2" });
    switchDoc("e2e-doc-1");
  });

  const tabB = await context.newPage();
  await tabB.goto("/d/tabdoc2");
  await tabB.waitForSelector("#editor-mount .cm-content", { state: "visible" });

  // Tab A edits doc 1 and lets it autosave.
  await page.bringToFront();
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("edit from tab A");
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").find((d: { id: string }) => d.id === "e2e-doc-1")?.content))
    .toBe("edit from tab A");

  // Tab B edits doc 2 and saves — must not resurrect a stale doc 1 or drop it.
  await tabB.bringToFront();
  await tabB.click("#editor-mount .cm-content");
  await tabB.keyboard.type("edit from tab B");
  await expect
    .poll(() => tabB.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").find((d: { id: string }) => d.id === "tabdoc2")?.content))
    .toBe("edit from tab B");

  const docs = await tabB.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]"));
  expect(docs.find((d: { id: string }) => d.id === "e2e-doc-1")?.content).toBe("edit from tab A");
  expect(docs.find((d: { id: string }) => d.id === "tabdoc2")?.content).toBe("edit from tab B");
});

test("DOC-15b: a document deleted in one tab stays deleted after another tab's next save", async ({ page, context }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "deldoc2", name: "Del Doc 2" });
    createDoc({ id: "deldoc3", name: "Del Doc 3" });
    switchDoc("e2e-doc-1");
  });

  const tabB = await context.newPage();
  await tabB.goto("/d/deldoc3");
  await tabB.waitForSelector("#editor-mount .cm-content", { state: "visible" });

  // Tab A deletes deldoc2 (no confirm — use the primitive directly).
  await page.bringToFront();
  await page.evaluate(() => import("/src/stores/docs.ts").then((m) => m.removeDocById("deldoc2")));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { id: string }) => d.id))).not.toContain("deldoc2");

  // Tab B saves (edits deldoc3) — deldoc2 must not come back.
  await tabB.bringToFront();
  await tabB.click("#editor-mount .cm-content");
  await tabB.keyboard.type("x");
  await expect.poll(() => tabB.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { id: string }) => d.id))).not.toContain("deldoc2");
});
