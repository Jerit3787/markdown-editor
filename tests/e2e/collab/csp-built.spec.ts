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

  // Fetch the raw HTML: browsers blank the `nonce` content attribute in
  // the parsed DOM (moving it to the .nonce IDL property), so the served
  // bytes are the only place to see what the Worker stamped.
  const res = await page.request.get("http://localhost:8787/");
  const csp = res.headers()["content-security-policy"] ?? "";
  const body = await res.text();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-src https://challenges.cloudflare.com");
  expect(csp).toMatch(/script-src [^;]*'nonce-/);
  expect(res.headers()["cache-control"]).toBe("no-store");

  // the static <meta> CSP is stripped in production
  expect(body).not.toContain('http-equiv="Content-Security-Policy"');

  // the header nonce is the one stamped on every <script> tag
  const headerNonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(headerNonce).toBeTruthy();
  const scriptTags = body.match(/<script[^>]*>/g) ?? [];
  expect(scriptTags.length).toBeGreaterThan(0);
  for (const tag of scriptTags) expect(tag).toContain(`nonce="${headerNonce}"`);

  // a second request gets a different nonce
  const res2 = await page.request.get("http://localhost:8787/");
  const csp2 = res2.headers()["content-security-policy"] ?? "";
  expect(csp2.match(/'nonce-([^']+)'/)?.[1]).not.toBe(headerNonce);

  // /privacy gets the strict variant, also nonce-based, also no <meta>
  const legal = await page.request.get("http://localhost:8787/privacy");
  const legalCspHeader = legal.headers()["content-security-policy"] ?? "";
  expect(legalCspHeader.startsWith("default-src 'none'")).toBe(true);
  expect(legalCspHeader).toMatch(/script-src 'nonce-/);
  expect(await legal.text()).not.toContain('http-equiv="Content-Security-Policy"');

  await ctx.close();
});
