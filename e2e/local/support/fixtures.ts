import { test as base } from "@playwright/test";

// Seeds a single local (non-collab) document + workspace before each
// test that needs one, then navigates to it. Every local spec file
// imports test/expect from here instead of "@playwright/test" directly.
// { auto: true } is required, not cosmetic — without it, a test that
// destructures only { page } (not { docId }) skips this fixture
// entirely (Playwright only instantiates fixtures a test actually
// requests), leaving the page unnavigated and localStorage unseeded.
// Confirmed live: two tests failed exactly this way (30s timeout on
// #editor-mount, then a cross-origin localStorage SecurityError on
// about:blank) before this was added.
export const test = base.extend<{ docId: string }>({
  docId: [async ({ page }, use) => {
    const docId = "e2e-doc-1";
    const now = Date.now();
    await page.goto("/");
    await page.evaluate(
      ({ docId, now }) => {
        localStorage.setItem(
          "mde:docs",
          JSON.stringify([
            { id: docId, name: "E2E Test Doc", content: "", createdAt: now, updatedAt: now, workspaceId: "e2e-ws-1" },
          ])
        );
        localStorage.setItem(
          "mde:workspaces",
          JSON.stringify([{ id: "e2e-ws-1", name: "Local", createdAt: now, updatedAt: now }])
        );
        localStorage.setItem("mde:active", docId);
        localStorage.setItem("mde:activeWorkspace", "e2e-ws-1");
        localStorage.setItem("mde:whatsNewSeen", "999.999.999");
      },
      { docId, now }
    );
    await page.goto(`/d/${docId}`);
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await use(docId);
  }, { auto: true }],
});
export { expect } from "@playwright/test";
