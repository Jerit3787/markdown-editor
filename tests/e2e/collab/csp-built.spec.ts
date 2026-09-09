import { test, expect } from "@playwright/test";

// The `collab` project's baseURL is wrangler dev serving client/dist — the
// only e2e context that runs the *built* bundle. Vite's production CSS
// pipeline inlines small assets (e.g. KaTeX's tiny fonts) as data: URIs
// that never appear under `vite dev`, so a font/style/img CSP directive
// can be wrong in prod while the local suite stays green. This catches it.
const CSP_RE = /Content Security Policy|Refused to (load|execute|connect|apply|frame)/i;

test("the built app renders math + a diagram with no CSP violation", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && CSP_RE.test(m.text())) violations.push(m.text());
  });

  await page.goto("http://localhost:8787/");
  await page.evaluate(() => {
    const now = Date.now();
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([
        {
          id: "csp-doc",
          name: "CSP",
          content: "# t\n\n$$\\sum_{i=1}^{n} i^{3}$$\n\n```mermaid\ngraph TD; A-->B;\n```\n",
          createdAt: now,
          updatedAt: now,
          workspaceId: "csp-ws",
        },
      ]),
    );
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "csp-ws", name: "Local", createdAt: now, updatedAt: now }]));
    localStorage.setItem("mde:active", "csp-doc");
    localStorage.setItem("mde:activeWorkspace", "csp-ws");
    localStorage.setItem("mde:whatsNewSeen", "999.999.999");
  });
  await page.goto("http://localhost:8787/");
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });

  await expect(page.locator("#preview-mount .katex").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#preview-mount pre.mermaid svg, #preview-mount .mermaid svg").first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500); // let async font/style loads settle

  expect(violations, `CSP violations in the built app:\n${violations.join("\n")}`).toEqual([]);
  await ctx.close();
});
