import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

const overlay = (page: Page) => page.locator(".diagram-editor-overlay");
const codeContent = (page: Page) => page.locator(".diagram-editor-code-host .cm-content");
const saveBtn = (page: Page) => page.locator(".diagram-editor-header button.primary-btn");

async function openNew(page: Page) {
  await page.click('button[title="Insert diagram"]');
  await expect(overlay(page)).toBeVisible();
}

async function setCode(page: Page, code: string) {
  await codeContent(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(code);
}

function docState(page: Page) {
  return page.evaluate(() => {
    const v = window.MDE.getEditor();
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const doc = docs.find((d: { id: string }) => d.id === "e2e-doc-1");
    return { text: v.state.doc.toString(), diagrams: (doc?.diagrams ?? {}) as Record<string, string> };
  });
}

test("PREV-19: create a diagram — blank start, type source, it renders, Save inserts the fence and stores the source", async ({ page }) => {
  await openNew(page);
  await expect(page.locator(".diagram-template-picker")).toBeVisible();
  await page.click('.diagram-template-picker button:has-text("start new")');

  await setCode(page, "flowchart TD\n  A --> B");
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });

  await expect(saveBtn(page)).toBeEnabled();
  await saveBtn(page).click();
  await expect(overlay(page)).toBeHidden();

  const state = await docState(page);
  expect(state.text).toMatch(/```mermaid\n[a-z0-9-]+\n```/);
  const keys = Object.keys(state.diagrams);
  expect(keys.length).toBe(1);
  expect(state.diagrams[keys[0]]).toContain("flowchart TD");
});

test("PREV-19b: editing an existing diagram overwrites its stored source, leaving the document text unchanged", async ({ page }) => {
  // Create one first.
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("start new")');
  await setCode(page, "flowchart TD\n  A --> B");
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
  await saveBtn(page).click();
  await expect(overlay(page)).toBeHidden();

  const before = await docState(page);
  const key = Object.keys(before.diagrams)[0];

  // Re-open the editor for that ref directly (the same store wiring the
  // rendered-diagram click handler uses).
  await page.evaluate(async (key) => {
    const { diagramEditorRef, diagramEditorOpen } = await import("/src/stores/diagramEditor.ts");
    diagramEditorRef.set(key);
    diagramEditorOpen.set(true);
  }, key);
  await expect(overlay(page)).toBeVisible();

  await setCode(page, "flowchart LR\n  X --> Y");
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
  await saveBtn(page).click();
  await expect(overlay(page)).toBeHidden();

  const after = await docState(page);
  expect(after.text).toBe(before.text); // document text (just the ref) unchanged
  expect(after.diagrams[key]).toContain("flowchart LR");
});

test("PREV-20: picking a template fills the code editor and dismisses the picker", async ({ page }) => {
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("Sequence")');
  await expect(page.locator(".diagram-template-picker")).toBeHidden();
  await expect(codeContent(page)).toContainText("sequenceDiagram");
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
});

test("PREV-20b: Reset view is available once a diagram is rendered", async ({ page }) => {
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("Flowchart")');
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
  const reset = page.locator(".diagram-preview-reset");
  await expect(reset).toBeVisible();
  await reset.click(); // no-throw; view returns to fit
});

test("PREV-21: Download PNG produces a .png download; Copy as SVG is offered", async ({ page }) => {
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("Pie")');
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });

  await page.click('.diagram-editor-header button:has-text("Export")');
  const menu = page.locator(".diagram-editor-header .dropdown-menu.open");
  await expect(menu.locator('button:has-text("Copy as SVG")')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), menu.locator('button:has-text("Download PNG")').click()]);
  // New (unsaved) diagram has no ref yet — filename falls back to "diagram.png".
  expect(download.suggestedFilename()).toMatch(/^(diagram|[a-z0-9-]+)\.png$/);
});
