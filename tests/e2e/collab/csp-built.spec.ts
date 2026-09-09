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

test("the built app is served with a per-request CSP nonce header and no <meta> CSP", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const res = await page.goto("http://localhost:8787/");
  const csp = res!.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-src https://challenges.cloudflare.com");
  expect(csp).toMatch(/script-src [^;]*'nonce-/);
  expect(res!.headers()["cache-control"]).toBe("no-store");

  // the static <meta> CSP is stripped in production
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count()).toBe(0);

  // the header nonce is the one stamped on the <script> tags
  const headerNonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(headerNonce).toBeTruthy();
  const scriptNonce = await page.locator("script[nonce]").first().getAttribute("nonce");
  expect(scriptNonce).toBe(headerNonce);

  // a second request gets a different nonce
  const res2 = await page.request.get("http://localhost:8787/");
  const csp2 = res2.headers()["content-security-policy"] ?? "";
  expect(csp2.match(/'nonce-([^']+)'/)?.[1]).not.toBe(headerNonce);

  // /privacy gets the strict variant, also nonce-based, also no <meta>
  const legal = await page.goto("http://localhost:8787/privacy");
  const legalCspHeader = legal!.headers()["content-security-policy"] ?? "";
  expect(legalCspHeader.startsWith("default-src 'none'")).toBe(true);
  expect(legalCspHeader).toMatch(/script-src 'nonce-/);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count()).toBe(0);

  await ctx.close();
});
