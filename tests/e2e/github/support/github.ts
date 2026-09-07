import { type Page } from "@playwright/test";

export const BASE = "http://localhost:8787";
export const GIST_ID = process.env.TEST_GITHUB_GIST_ID ?? "";
export const REPO = process.env.TEST_GITHUB_REPO ?? ""; // "owner/name"
export const USERNAME = process.env.TEST_GITHUB_USERNAME ?? "";

export async function dismissWhatsNew(page: Page): Promise<void> {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
}

// Injects a session carrying the real test-account token, then lands on
// the app. Deliberately no /api/auth/github/me route stub — the whole
// point is that the real endpoint verifies the real token and reports its
// scopes (a classic PAT returns "repo, gist" in X-OAuth-Scopes, which is
// what hasRepoScope() checks for the repo flows).
export async function signInReal(page: Page): Promise<void> {
  await page.goto(`${BASE}/api/dev/login?real=1`);
  await page.goto(BASE);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await page.waitForFunction(() => Boolean((window as unknown as { MDE?: { githubUsername?: string } }).MDE?.githubUsername), {
    timeout: 15000,
  });
  await dismissWhatsNew(page);
}

export type LocalDoc = { id: string; name: string; content: string; repoPath?: string; gistId?: string; workspaceId?: string };

export async function readDocs(page: Page): Promise<LocalDoc[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]"));
}

export async function readActiveWorkspace(
  page: Page,
): Promise<{ id: string; name: string; repoLink?: { owner: string; repo: string; branch: string } } | null> {
  return page.evaluate(() => {
    const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const active = localStorage.getItem("mde:activeWorkspace");
    return wss.find((w: { id: string }) => w.id === active) ?? null;
  });
}
