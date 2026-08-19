import type { Page } from "@playwright/test";

const BASE = "http://localhost:8787";

// Mirrors two-user-live-sync.mjs's stubGithubIdentity (now retired) —
// /api/auth/github/me actively re-verifies the session token against
// GitHub's real API, which a fake dev-login token correctly fails,
// blocking any Share-gated flow. Intercepted at the network level (not
// a page.evaluate() stub) because some of those flows run at page-load
// time, before a stub could land.
export async function signInAsDevUser(page: Page, username: string): Promise<void> {
  await page.route("**/api/auth/github/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) })
  );
  await page.goto(`${BASE}/api/dev/login?username=${username}`);
}
