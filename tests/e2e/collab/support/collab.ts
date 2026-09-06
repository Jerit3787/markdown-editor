import { expect, type Page } from "@playwright/test";
import { signInAsDevUser } from "./dev-login";
import { readSharedState } from "./share";

export const BASE = "http://localhost:8787";

export async function dismissWhatsNew(page: Page): Promise<void> {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
}

// window.MDE.newDoc() silently no-ops on a truly fresh context with zero
// workspaces (see live-sync.spec.ts) — #emptyNewWorkspaceBtn is the real
// empty-state UI's own "create a workspace" action.
export async function createFirstWorkspaceAndDoc(page: Page): Promise<void> {
  await page.click("#emptyNewWorkspaceBtn");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
}

// Full owner setup: sign in, land on the app, create the first workspace +
// doc, type `content` into it.
export async function ownerWithDoc(page: Page, username: string, content: string): Promise<void> {
  await signInAsDevUser(page, username);
  await page.goto(BASE);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(page);
  await createFirstWorkspaceAndDoc(page);
  if (content) {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type(content);
  }
}

// Opens the Share modal, switches general access to "Anyone with the link"
// at the given role, closes the modal, and returns the join URL for the
// active doc.
export async function shareAnyoneLink(page: Page, role: "Viewer" | "Reviewer" | "Editor" = "Editor"): Promise<string> {
  await page.click("#shareBtn");
  const moveDialog = page.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();

  const accessSelect = page.locator('select[aria-label="General access"]');
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);

  // The link role defaults to Viewer when general access is first set to
  // "anyone" — always set it explicitly.
  const roleSelect = page.locator('select[aria-label="Access level for people with the link"]');
  await roleSelect.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    roleSelect.selectOption({ label: role }),
  ]);

  const state = await readSharedState(page);
  const url = `${BASE}/w/${state.ws!.remoteId}/${state.activeDoc!.id}/edit`;

  const doneBtn = page.locator('button:has-text("Done")');
  if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) await doneBtn.click();
  await page.keyboard.press("Escape").catch(() => {});
  return url;
}

// Second collaborator joins a share link and settles.
export async function joinSharedWorkspace(page: Page, shareUrl: string): Promise<void> {
  await page.goto(shareUrl);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = page.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(page);
}

export function editorText(page: Page): Promise<string> {
  return page.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "");
}

export async function expectEditorContains(page: Page, text: string, timeout = 15000): Promise<void> {
  await expect.poll(() => editorText(page), { timeout }).toContain(text);
}
