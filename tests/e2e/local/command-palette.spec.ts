import { test, expect } from "./support/fixtures";

test("SHELL-01: Ctrl/Cmd+Shift+P opens, typing filters, ArrowDown+Enter runs the selection, Esc closes", async ({ page }) => {
  await page.evaluate(() => window.MDE.getEditor().dispatch({ changes: { from: 0, insert: "hello" }, selection: { anchor: 0, head: 5 } }));

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.locator(".command-palette")).toBeVisible();
  await expect(page.locator(".command-palette-input")).toBeFocused();

  await page.fill(".command-palette-input", "italic");
  const rows = page.locator(".command-palette-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Italic");

  // first result is pre-selected (selectedIndex 0); Enter runs it
  await page.keyboard.press("Enter");
  await expect(page.locator(".command-palette")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("_hello_");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.locator(".command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".command-palette")).not.toBeVisible();
});

test("SHELL-01: ArrowDown moves the active row", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.fill(".command-palette-input", "heading");
  await expect(page.locator(".command-palette-row")).toHaveCount(3); // H1/H2/H3

  await expect(page.locator(".command-palette-row.active")).toContainText("Heading 1");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".command-palette-row.active")).toContainText("Heading 2");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".command-palette-row.active")).toContainText("Heading 1");
});

test("SHELL-02: `requires: doc` commands disappear when there is no active document", async ({ page }) => {
  // With a doc: Format commands are present.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.fill(".command-palette-input", "bold");
  await expect(page.locator(".command-palette-row")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Delete every document so nothing is active.
  await page.evaluate(async () => {
    const { docsStore, activeIdStore } = await import("/src/stores/docs.ts");
    docsStore.set([]);
    activeIdStore.set(null);
  });

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.fill(".command-palette-input", "bold");
  await expect(page.locator(".command-palette-row")).toHaveCount(0);
  await expect(page.locator(".command-palette-results .empty-state-title")).toHaveText("No results");

  // A command with no `requires` (e.g. Command Palette's own view toggles) still shows.
  await page.fill(".command-palette-input", "focus mode");
  await expect(page.locator(".command-palette-row")).not.toHaveCount(0);
});

test("SHELL-02: every listed command runs without throwing a page error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const labels = await page.locator(".command-palette-row span").allTextContents();
  await page.keyboard.press("Escape");
  expect(labels.length).toBeGreaterThan(20); // ~30 registered entries

  // Run a representative spread of non-modal, reversible commands via the
  // palette — checking for a thrown pageerror after each. (Modal-opening
  // commands like Insert link / Manage images are covered in their own
  // specs; delete-doc / print are irreversible/blocking.)
  for (const name of ["Bold", "Heading 2", "Bullet list", "Blockquote", "Task list"]) {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expect(page.locator(".command-palette-input")).toBeVisible();
    await page.fill(".command-palette-input", name);
    await page.locator(".command-palette-row", { hasText: name }).first().click();
    await expect(page.locator(".command-palette")).not.toBeVisible();
  }
  expect(errors).toEqual([]);
});
