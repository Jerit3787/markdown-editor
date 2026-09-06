import { test, expect } from "./support/fixtures";

// The seeded fixture doc uses the id "e2e-doc-1" (hyphens); the real
// `/d/<id>` route only matches base36 ids the way `uid()` produces them,
// so these tests create docs with clean alphanumeric ids and route
// between those.

test("DOC-18: deep-linking to /d/<id> resolves that exact document", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "deeptarget1", name: "Deep Target", content: "TARGET CONTENT" });
    createDoc({ id: "deepother1", name: "Deep Other", content: "OTHER CONTENT" });
    switchDoc("e2e-doc-1");
  });

  await page.goto("/d/deepother1");
  await page.waitForSelector("#editor-mount .cm-content");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("OTHER CONTENT");

  await page.goto("/d/deeptarget1");
  await page.waitForSelector("#editor-mount .cm-content");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("TARGET CONTENT");
  expect(await page.evaluate(() => localStorage.getItem("mde:active"))).toBe("deeptarget1");
});

test("DOC-19: switching documents updates the URL; browser back/forward navigates between them", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "navb1", name: "Nav B" }); // createDoc activates it
    createDoc({ id: "nava1", name: "Nav A" });
  });
  // Start on nava1, switch to navb1 — URL follows.
  await expect(page).toHaveURL(/\/d\/nava1$/);
  await page.evaluate(() => window.MDE.switchDoc("navb1"));
  await expect(page).toHaveURL(/\/d\/navb1$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/d\/nava1$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mde:active"))).toBe("nava1");

  await page.goForward();
  await expect(page).toHaveURL(/\/d\/navb1$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mde:active"))).toBe("navb1");
});

test("DOC-19b: deleting the only document replaces the URL with /", async ({ page }) => {
  await page.evaluate(() => import("/src/stores/docs.ts").then((m) => m.removeDocById("e2e-doc-1")));
  await expect(page).toHaveURL(/\/$/);
});

test("DOC-20: a sidebar row is a real link with an href, usable for opening a document in a new tab", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "rowtarget1", name: "Row Target" });
    switchDoc("e2e-doc-1");
  });
  const row = page.locator('.doc-row-link[href="/d/rowtarget1"]');
  await expect(row).toHaveAttribute("href", "/d/rowtarget1");

  // A modified click is not swallowed by the app's own click handler
  // (which returns early on meta/ctrl/shift), so the browser is free to
  // open it in a new tab.
  const notPrevented = await row.evaluate((el: HTMLAnchorElement) => {
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true });
    el.dispatchEvent(ev);
    return !ev.defaultPrevented;
  });
  expect(notPrevented).toBe(true);

  // A plain click IS handled by the app (SPA navigation, no full load).
  await row.click();
  await expect(page).toHaveURL(/\/d\/rowtarget1$/);
});

test("DOC-12: a pre-workspace localStorage shape migrates into a default workspace with a working editor", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "legacy1", name: "Legacy Doc", content: "legacy body", createdAt: 1, updatedAt: 1 }]));
    localStorage.setItem("mde:active", "legacy1");
    localStorage.setItem("mde:whatsNewSeen", "999.999.999");
  });
  await page.goto("/d/legacy1");
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("legacy body");

  const state = await page.evaluate(() => ({
    wss: JSON.parse(localStorage.getItem("mde:workspaces") || "[]"),
    doc: JSON.parse(localStorage.getItem("mde:docs") || "[]").find((d: { id: string }) => d.id === "legacy1"),
  }));
  expect(state.wss.length).toBeGreaterThanOrEqual(1);
  expect(state.doc.workspaceId).toBeTruthy();
});
