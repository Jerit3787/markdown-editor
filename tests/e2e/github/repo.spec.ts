import { test, expect, type Page } from "@playwright/test";
import { REPO, signInReal, readDocs, readActiveWorkspace } from "./support/github";

// REPO-19 / REPO-22 — linking a workspace to a GitHub repo through the UI
// pulls every .md recursively and records the repoLink. Drives the real
// /api/repo/* proxy endpoints against the fixture repo (see
// tests/e2e/github/README.md).

const [OWNER, NAME] = REPO.split("/");

async function expectFixtureRepoPulled(page: Page) {
  // createWorkspaceFromRepo runs its own progress toast, resolved to success.
  await expect(
    page
      .locator(".toast")
      .filter({ hasText: /repo|pulled|synced|linked/i })
      .first(),
  ).toBeVisible({ timeout: 20000 });

  await expect
    .poll(
      async () => {
        const paths = (await readDocs(page)).map((d) => d.repoPath).filter(Boolean);
        return [...paths].sort();
      },
      { timeout: 20000 },
    )
    .toEqual(["README.md", "docs/architecture.md", "docs/deep/notes.md"]);

  const ws = await readActiveWorkspace(page);
  expect(ws?.repoLink).toMatchObject({ owner: OWNER, repo: NAME, branch: "main" });
}

test("REPO-19: linking a workspace to a repo pulls every .md recursively", async ({ page }) => {
  await signInReal(page);
  await page.click("#emptyNewWorkspaceBtn"); // a workspace to link
  await page.click("#menuOpenRepo");
  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toBeVisible();

  await page.fill('input[aria-label="owner/repo"]', REPO);
  await page.press('input[aria-label="owner/repo"]', "Enter");

  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toHaveCount(0, { timeout: 15000 });
  await expectFixtureRepoPulled(page);
});

test("REPO-22: the no-workspace empty state loads a workspace from a repo", async ({ page }) => {
  await signInReal(page);
  // A fresh context has zero workspaces -> the no-workspace empty state.
  await page.click("#emptyOpenRepoBtn");
  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toBeVisible({ timeout: 10000 });

  await page.fill('input[aria-label="owner/repo"]', REPO);
  await page.press('input[aria-label="owner/repo"]', "Enter");

  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toHaveCount(0, { timeout: 15000 });
  await expectFixtureRepoPulled(page);

  const wsCount = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:workspaces") || "[]").length);
  expect(wsCount).toBe(1);
});
