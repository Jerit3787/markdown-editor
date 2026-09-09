# CSP Nonce Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Content-Security-Policy as a per-request `nonce` on a real response header set by the Worker, so Cloudflare's edge-injected JavaScript Detections script stops violating the policy.

**Architecture:** A new pure module `src/csp.ts` builds the policy string for a given nonce. The Worker's terminal `env.ASSETS.fetch()` fall-through gains an `HTMLRewriter` pass that, for `text/html` responses only, strips the static `<meta>` CSP, stamps `nonce="…"` on every `<script>`, and sets the `Content-Security-Policy` + `Cache-Control: no-store` headers. `client/index.html` and `legal/*.html` keep their `<meta>` CSP unchanged — it becomes the dev-only policy the `vite dev` `local` test suite runs under.

**Tech Stack:** Cloudflare Workers (`HTMLRewriter`, Web Crypto `crypto.getRandomValues`, `btoa`), TypeScript (strict `src/` tsconfig), Vitest (`unit` project), Playwright (`collab` project against `wrangler dev`).

**Spec:** `docs/superpowers/specs/2026-09-09-csp-nonce-pipeline-design.md`

## Global Constraints

- `src/csp.ts` and `tests/src/csp.test.ts` are under the **full-strict** root `tsconfig.json` (`src/**`, `tests/src/**`). `npm run typecheck` runs `tsc --noEmit` on it.
- The `local` Playwright project (200+ tests) runs against **`vite dev`** — no Worker, no `_headers`. Its CSP coverage (`tests/e2e/local/csp.spec.ts`) must keep passing unchanged, under the `<meta>` policy that stays in `client/index.html`.
- `npm run format:check` (Prettier) must pass. `client/public/_headers` is already in `.prettierignore`.
- The `unit` Vitest project globs `tests/**/*.test.ts` (excluding `tests/client/src/components/**`), so both `tests/src/csp.test.ts` and `tests/client/src/csp.test.ts` run under `npm test`.
- `wrangler.jsonc` already sets `assets.run_worker_first: true` — `src/worker.ts`'s `fetch()` runs before the asset layer on every request.
- The built HTML shell has exactly two `<script>` tags (Vite entry bundle + one attribute-less inline snippet). `legal/*.html` have zero.
- Worker source imports use a `.js` extension on relative paths (e.g. `import { ... } from "./turnstile.js"`).
- Release: patch `1.60.3`. `package.json` + both `"version"` fields in `package-lock.json` (lines 3 and 9), hand-edited. `CHANGELOG.md` `### Changed`, **no** `client/src/whats-new-entries.ts` entry, no screenshot.
- Never add a `Claude-Session:` trailer to commits. `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only.
- Branch: `docs/csp-nonce-spec` already exists with the spec commit. Do all implementation work on that branch (rename it or keep it — the PR ships spec + plan + code together).

---

### Task 1: `src/csp.ts` — the policy builder module

**Files:**
- Create: `src/csp.ts`
- Test: `tests/src/csp.test.ts` (create)

**Interfaces:**
- Consumes: nothing (pure module, no imports).
- Produces:
  - `generateNonce(): string` — a fresh base64 string decoding to 16 random bytes.
  - `appCsp(nonce: string): string` — the app-shell CSP, one line, `;`-separated. `script-src` contains `'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://www.googletagmanager.com`.
  - `legalCsp(nonce: string): string` — the `/privacy` + `/terms` CSP, one line. Starts `default-src 'none'`; `script-src` is exactly `'nonce-${nonce}'`.

- [ ] **Step 1: Write the failing test**

Create `tests/src/csp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateNonce, appCsp, legalCsp } from "../../src/csp";

describe("generateNonce", () => {
  it("returns a base64 string that decodes to 16 bytes", () => {
    const n = generateNonce();
    expect(typeof n).toBe("string");
    expect(n.length).toBeGreaterThan(0);
    expect(atob(n).length).toBe(16);
  });

  it("returns a different value on each call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(seen.size).toBe(50);
  });
});

describe("appCsp", () => {
  const nonce = "TESTNONCEtestnonce123456==";
  const csp = appCsp(nonce);

  it("puts the nonce in script-src", () => {
    expect(csp).toMatch(new RegExp(`script-src [^;]*'nonce-${nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  });

  it("keeps every directive the app needs", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("keeps the GA + Turnstile allowlist alongside the nonce", () => {
    expect(csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/script-src [^;]*https:\/\/www\.googletagmanager\.com/);
    expect(csp).toContain("https://*.google-analytics.com");
    expect(csp).toContain("https://*.analytics.google.com");
  });

  it("never allows unsafe-inline or unsafe-eval in script-src", () => {
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("is a single line and stable for a given nonce", () => {
    expect(csp).not.toContain("\n");
    expect(appCsp(nonce)).toBe(csp);
  });
});

describe("legalCsp", () => {
  const nonce = "LEGALNONCElegalnonce9876==";
  const csp = legalCsp(nonce);

  it("is default-src 'none' with only the nonce in script-src", () => {
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!.trim();
    expect(scriptSrc).toBe(`script-src 'nonce-${nonce}'`);
  });

  it("locks base-uri and form-action down", () => {
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'none'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/src/csp.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/csp"`.

- [ ] **Step 3: Write the module**

Create `src/csp.ts`:

```ts
// Per-request Content-Security-Policy for HTML responses.
//
// Delivered by src/worker.ts as a real response header (not <meta>)
// carrying a fresh `nonce` per request. Cloudflare's edge-injected
// JavaScript Detections script has an inline body that rotates every
// request (ray id + timestamp) and cannot be hash-pinned; Cloudflare
// stamps its injected <script> tags with the nonce it finds in this
// header, so JSD runs without a violation.
//
// client/index.html and legal/*.html keep their own static <meta> CSP
// as the policy enforced under `vite dev` (no Worker there). In
// production the Worker strips that <meta> and sets the header below.

/** A fresh CSP nonce: 16 random bytes, standard base64 (24 chars). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/**
 * The app-shell policy. Identical to the v1.60.2 <meta> policy except
 * `script-src` swaps the inline-script hash for the per-request nonce.
 */
export function appCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://www.googletagmanager.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com",
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * The /privacy and /terms policy. Those pages ship zero script of their
 * own; `script-src 'nonce-…'` exists ONLY so Cloudflare's injected JSD
 * inline script is stamped and runs cleanly.
 */
export function legalCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/src/csp.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `tsc` complains that `btoa` or `crypto` is undefined, the fix is a one-line reference — but `@cloudflare/workers-types` (in `devDependencies`, applied by the root `tsconfig.json`) provides both globals, so it should be clean.

- [ ] **Step 6: Commit**

```bash
git add src/csp.ts tests/src/csp.test.ts
git commit -m "$(cat <<'EOF'
feat(csp): add the per-request nonce policy builder

src/csp.ts: generateNonce() plus appCsp(nonce) / legalCsp(nonce). Pure,
no I/O. The Worker will use these to set a Content-Security-Policy
response header per request (next task).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Worker HTML transform + `_headers` + unit-test trim + collab e2e

**Files:**
- Modify: `src/worker.ts` — import block (line 1-6) + the terminal `return env.ASSETS.fetch(request);` (last line of `fetch()`, currently line ~176)
- Modify: `client/public/_headers` — remove the `Content-Security-Policy:` line
- Modify: `tests/client/src/csp.test.ts` — drop the `<meta>`↔`_headers` parity `it`, add a "no CSP in `_headers`" `it`, reword the describe
- Modify: `tests/e2e/collab/csp-built.spec.ts` — add nonce-header assertions
- Modify: `tests/e2e/collab/live-sync.spec.ts` — add a `'nonce-'` assertion to the existing header test

**Interfaces:**
- Consumes: `generateNonce`, `appCsp`, `legalCsp` from `./csp.js` (Task 1).
- Produces: every `text/html` response from the Worker now carries a `Content-Security-Policy` header with a `'nonce-<n>'` in `script-src`, `Cache-Control: no-store`, no `<meta http-equiv="Content-Security-Policy">` in the body, and `nonce="<n>"` on every `<script>` tag.

- [ ] **Step 1: Trim the unit test (write the failing assertion first)**

In `tests/client/src/csp.test.ts`:

1. Delete this block entirely (currently lines ~65-67):

```ts
  it("the _headers file's CSP is byte-identical to the <meta>", () => {
    expect(headerValue(headersFile, "Content-Security-Policy")).toBe(csp);
  });
```

2. In its place add:

```ts
  it("the _headers file no longer carries a CSP — the Worker sets it per request", () => {
    expect(headersFile).not.toContain("Content-Security-Policy");
  });
```

3. Change the top-of-`describe` comment/line so the intent is clear. Replace:

```ts
describe("app Content-Security-Policy", () => {
  const csp = metaCsp(indexHtml);
```

with:

```ts
// client/index.html keeps its <meta> CSP as the policy enforced under
// `vite dev` (which runs no Worker). Production strips this <meta> and
// serves a per-request nonce header instead — see src/csp.ts and the
// collab e2e specs. This suite guards the dev policy + the companion
// headers that stay in _headers.
describe("app Content-Security-Policy (dev <meta> policy)", () => {
  const csp = metaCsp(indexHtml);
```

Leave everything else in the file as-is (the directive checks, the inline-script hash recompute, the companion-header checks, the `/*` first-line check, the legal-page checks).

- [ ] **Step 2: Run it to verify the new assertion fails**

Run: `npx vitest run tests/client/src/csp.test.ts`
Expected: FAIL — `_headers` still contains `Content-Security-Policy`.

- [ ] **Step 3: Remove the CSP line from `_headers`**

Edit `client/public/_headers` to exactly:

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
```

(Drop only the second line — the `Content-Security-Policy: …` one. Keep the two-space indentation on the rest.)

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run tests/client/src/csp.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the Worker import**

In `src/worker.ts`, add to the import block at the top (after the existing `import type { Env } from "./env";` line):

```ts
import { generateNonce, appCsp, legalCsp } from "./csp.js";
```

- [ ] **Step 6: Replace the terminal asset return with the transform**

In `src/worker.ts`, find the final statement of `fetch()` (after the `// Terms / Privacy …` comment block):

```ts
    return env.ASSETS.fetch(request);
```

Replace that single line with:

```ts
    const assetRes = await env.ASSETS.fetch(request);
    const contentType = assetRes.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return assetRes;

    // HTML gets a per-request CSP nonce header instead of the static
    // <meta> tag baked into the asset. Cloudflare stamps its edge-injected
    // JavaScript Detections <script> tags with the nonce it parses out of
    // this header — the only way JSD (rotating inline body, unhashable)
    // and a CSP without 'unsafe-inline' can coexist. See src/csp.ts.
    const nonce = generateNonce();
    const isLegalPage = url.pathname === "/privacy" || url.pathname === "/terms";
    const policy = isLegalPage ? legalCsp(nonce) : appCsp(nonce);

    const rewritten = new HTMLRewriter()
      .on('meta[http-equiv="Content-Security-Policy"]', { element: (el) => el.remove() })
      .on("script", { element: (el) => el.setAttribute("nonce", nonce) })
      .transform(assetRes);

    const headers = new Headers(rewritten.headers);
    headers.set("Content-Security-Policy", policy);
    // A cached HTML doc carries a fixed nonce; a later request's JSD
    // injection would use a different one and be blocked. no-store on the
    // small shell keeps body, header and injected script in agreement.
    // The hashed /assets/* bundles are non-HTML and keep caching.
    headers.set("Cache-Control", "no-store");
    return new Response(rewritten.body, {
      status: rewritten.status,
      statusText: rewritten.statusText,
      headers,
    });
```

Note: `url` is already in scope (declared `const url = new URL(request.url);` at the top of `fetch()`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `HTMLRewriter`, `Response`, `Headers` are all `@cloudflare/workers-types` globals.

- [ ] **Step 8: Manual smoke check against `wrangler dev`**

```bash
npm run build
npx wrangler dev --local-upstream localhost:8787 &
# wait ~5s for ready
curl -sD - -o /dev/null http://localhost:8787/ | grep -i 'content-security-policy\|cache-control'
curl -s http://localhost:8787/ | grep -c 'nonce='          # expect 2 (both <script> tags)
curl -s http://localhost:8787/ | grep -c 'http-equiv="Content-Security-Policy"'   # expect 0
curl -sD - -o /dev/null http://localhost:8787/privacy | grep -i 'content-security-policy'   # expect default-src 'none'
kill %1; lsof -ti:8787 | xargs -r kill -9
```

Expected: the CSP header value contains `script-src 'self' 'nonce-…'`, `cache-control: no-store`, two `nonce=` occurrences in the body, zero CSP `<meta>`, and `/privacy`'s header starts `default-src 'none'`.

- [ ] **Step 9: Extend `tests/e2e/collab/csp-built.spec.ts`**

The file currently navigates to `http://localhost:8787/` twice (before and after seeding localStorage). Change the **second** `await page.goto("http://localhost:8787/");` (line ~39) to capture the response, and add a new `test(...)` block after the existing one. Full new block to append at the end of the file:

```ts
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
```

Leave the existing `test("the built app renders math + a diagram with no CSP violation", …)` untouched — it now exercises the header policy instead of the `<meta>` one, which is exactly what we want it to prove.

- [ ] **Step 10: Update the header assertion in `tests/e2e/collab/live-sync.spec.ts`**

In `test("the built app is served with the CSP and companion security headers")`, after the existing `expect(h["content-security-policy"]).toContain("frame-src https://challenges.cloudflare.com");` line, add:

```ts
  expect(h["content-security-policy"]).toMatch(/script-src [^;]*'nonce-/);
```

- [ ] **Step 11: Run the collab e2e suite**

Run: `npm run test:e2e:collab`
Expected: PASS — including the two `csp-built.spec.ts` tests and the `live-sync.spec.ts` header test. This suite builds the client, starts `wrangler dev`, applies the dev-login patch, and runs serially (`--workers=1`).

If the Playwright browser binary is missing in a sandbox, follow `CLAUDE.md`'s "Sandboxed Claude Code environments" note (point `launchOptions.executablePath` at `/opt/pw-browsers/chromium`, run, revert).

- [ ] **Step 12: Run the full unit suite + format check**

Run: `npm test && npm run format:check`
Expected: PASS. (`_headers` is prettier-ignored; `src/csp.ts`, `src/worker.ts` and the test files must be formatted.)

- [ ] **Step 13: Commit**

```bash
git add src/worker.ts client/public/_headers tests/client/src/csp.test.ts tests/e2e/collab/csp-built.spec.ts tests/e2e/collab/live-sync.spec.ts
git commit -m "$(cat <<'EOF'
feat(csp): serve the CSP as a per-request nonce header from the Worker

The Worker now transforms every text/html asset response: strips the
<meta> CSP, stamps a fresh nonce on each <script>, and sets the
Content-Security-Policy + Cache-Control: no-store headers. Cloudflare's
edge-injected JavaScript Detections script — inline body rotates per
request, unhashable — is stamped with the same nonce by Cloudflare's
CSP-header parser, so it stops violating the policy.

client/index.html and legal/*.html keep their <meta> CSP as the dev-only
policy the vite-dev `local` e2e suite runs under. _headers drops its CSP
line (the Worker owns it now) and keeps the five companion headers.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Release bookkeeping (1.60.3) + docs

**Files:**
- Modify: `package.json` (`"version"`)
- Modify: `package-lock.json` (lines 3 and 9, both `"version": "1.60.2"` → `"1.60.3"`)
- Modify: `CHANGELOG.md` (new `## [1.60.3]` section at top)
- Modify: `docs/TEST-COVERAGE.md` (`SHELL-38` row)
- Modify: `ROADMAP.md` (the shipped-CSP bullet)
- Modify: `docs/superpowers/specs/2026-09-09-content-security-policy-design.md` (strike the nonce-pipeline non-goal)

**Interfaces:** none (docs + version only).

- [ ] **Step 1: Bump the version**

`package.json`: `"version": "1.60.2"` → `"version": "1.60.3"`.
`package-lock.json`: both occurrences (line 3, line 9) `"version": "1.60.2"` → `"1.60.3"`. Do not regenerate the lockfile.

- [ ] **Step 2: Add the CHANGELOG section**

Insert directly above `## [1.60.2] - 2026-09-09`:

```markdown
## [1.60.3] - 2026-09-09

### Changed

- The Content-Security-Policy is now delivered as a per-request `nonce` on a response header set by the Worker, instead of a static `<meta>` tag. Same policy, same allowlist (self, Google Analytics, Cloudflare Turnstile) — no change to how the app behaves. This keeps the CSP compatible with Cloudflare's bot-detection script, which injects an inline script whose contents change on every request and so cannot be allow-listed by hash.

```

- [ ] **Step 3: Update the `SHELL-38` row in `docs/TEST-COVERAGE.md`**

Replace the `| SHELL-38 | … | v1.60.2 |` row (line ~542) with:

```
| SHELL-38 | Content-Security-Policy — `src/csp.ts` builds the policy per request (`appCsp(nonce)` / `legalCsp(nonce)`, no `'unsafe-inline'`/`'unsafe-eval'` in `script-src`, GA + Turnstile allowlist kept, `generateNonce()` distinct 16-byte base64); the Worker transforms every `text/html` response — strips the `<meta>` CSP, stamps `nonce="…"` on every `<script>`, sets `Content-Security-Policy` + `Cache-Control: no-store`. `client/index.html` + `legal/*.html` keep a `<meta>` CSP as the `vite dev` policy (`default-src 'self'` / `object-src 'none'` / inline snippet pinned by recomputed `sha256`; legal pages `default-src 'none'`); `client/public/_headers` carries only `X-Frame-Options: DENY` / `nosniff` / `Referrer-Policy` / `Permissions-Policy` / `COOP` (no CSP). End-to-end: editing + inline math + Mermaid + data/remote images + every menu + HTML/MD/PDF export produce no CSP violation under `vite dev`; against the built bundle on `wrangler dev` — math + a diagram render clean, `GET /` and `GET /privacy` return a nonce-bearing CSP header with no `<meta>` CSP in the body, two requests get distinct nonces, the header nonce matches the `<script nonce>` attr, `Cache-Control: no-store`. JSD-compatibility itself is edge-only — verified manually post-deploy. | unit + e2e + e2e-collab | covered | `tests/src/csp.test.ts`, `tests/client/src/csp.test.ts`, `tests/e2e/local/csp.spec.ts`, `tests/e2e/collab/csp-built.spec.ts`, `tests/e2e/collab/live-sync.spec.ts` | v1.60.3 |
```

- [ ] **Step 4: Update the ROADMAP bullet**

In `ROADMAP.md`, the `- [x] A Content-Security-Policy — **shipped v1.60.2**` bullet (line ~572): change the final `Deferred:` sentence from

```
      Deferred: a `report-to` violation
      endpoint, a nonce-per-response pipeline, Trusted Types.
```

to

```
      The `<meta>` was replaced by a per-request Worker-set nonce header
      in **v1.60.3** (spec
      `docs/superpowers/specs/2026-09-09-csp-nonce-pipeline-design.md`) for
      compatibility with Cloudflare's JavaScript Detections injection.
      Still deferred: a `report-to` violation endpoint, Trusted Types.
```

- [ ] **Step 5: Strike the non-goal in the v1.60.2 spec**

In `docs/superpowers/specs/2026-09-09-content-security-policy-design.md`, under `## Non-goals / deferred`, replace the bullet:

```
- **A nonce-per-response pipeline.** One 3-line inline script does not justify per-request HTML rewriting. Its `sha256` hash goes in the policy instead.
```

with:

```
- ~~**A nonce-per-response pipeline.**~~ Superseded — shipped in v1.60.3 (`docs/superpowers/specs/2026-09-09-csp-nonce-pipeline-design.md`) once Cloudflare's JavaScript Detections turned out to inject an unhashable rotating inline script that a static policy can't allow.
```

- [ ] **Step 6: Verify the build and suite**

Run: `npm run build && npm test && npm run typecheck && npm run format:check`
Expected: all PASS. `WhatsNew.svelte`'s dev warning about the last whats-new entry not matching `__APP_VERSION__` is expected and harmless (patch release, no entry — matches `CLAUDE.md`).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md docs/TEST-COVERAGE.md ROADMAP.md docs/superpowers/specs/2026-09-09-content-security-policy-design.md
git commit -m "$(cat <<'EOF'
chore: release 1.60.3 — CSP nonce pipeline

CHANGELOG ### Changed (no What's New — no visible behaviour change).
TEST-COVERAGE SHELL-38, ROADMAP, and the v1.60.2 spec's non-goals
updated to reflect the nonce header replacing the <meta>.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: PR + post-deploy JSD verification

**Files:** none (process).

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --repo Jerit3787/markdown-editor --base master \
  --title "CSP nonce pipeline (v1.60.3)" \
  --body "$(cat <<'EOF'
Moves CSP delivery from a static `<meta>`/`_headers` policy to a
per-request `nonce` on a Worker-set response header, so Cloudflare's
JavaScript Detections script (rotating inline body, unhashable) stays
compatible with the policy.

- `src/csp.ts` — `generateNonce` / `appCsp` / `legalCsp`
- `src/worker.ts` — `HTMLRewriter` pass over `text/html`: strip `<meta>` CSP, nonce every `<script>`, set CSP + `Cache-Control: no-store`
- `client/index.html` + `legal/*.html` unchanged — their `<meta>` is now the `vite dev` policy
- `_headers` drops its CSP line, keeps the five companion headers
- Same allowlist, no behaviour change → patch `1.60.3`, no What's New

Spec: `docs/superpowers/specs/2026-09-09-csp-nonce-pipeline-design.md`
Plan: `docs/superpowers/plans/2026-09-09-csp-nonce-pipeline.md`

JSD nonce-stamping is a Cloudflare edge feature — not exercisable in CI.
Verified post-deploy per the plan's Task 4.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Wait for CI green, then merge**

Wait for `.github/workflows/test.yml` to pass (`npm test`, `npm run build`, `npm run typecheck`, `npm run format:check`, local Playwright e2e). Do not merge on red. Merge with a real merge commit (not squash). `auto-tag.yml` tags `v1.60.3` and triggers the release; Cloudflare auto-deploys from `master`.

- [ ] **Step 3: Post-deploy JSD check on `editor.danplace.tech`**

Once the deploy lands (check `https://editor.danplace.tech/` returns the new bundle hash), in a real browser with DevTools console open, hard-reload and verify:

1. **Zero CSP violations** in the console.
2. Network: `/cdn-cgi/challenge-platform/scripts/jsd/main.js` → 200, executes, no "Refused to execute inline script" for its bootstrap.
3. View source: the injected JSD `<script>` tags carry `nonce="…"` equal to the `Content-Security-Policy` response header's nonce.
4. Repeat on `https://editor.danplace.tech/privacy`.
5. Confirm the editor loads, GA fires (`/g/collect` in network, no `connect-src` violation), and — if a share link is handy — a Turnstile widget still renders.

- [ ] **Step 4: If JSD still violates (Cloudflare didn't stamp the nonce)**

Fallback, no code: the blocked script is Cloudflare bot telemetry only and does not affect the app (the editor loads and runs with it blocked — confirmed during this work). Add one line to the `ROADMAP.md` CSP bullet noting the residual JSD console violation is accepted, and note it on the PR. The nonce-header migration still stands as cleaner CSP delivery. Do **not** add `'unsafe-inline'`.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Part 1 — `src/csp.ts` (`generateNonce`, `appCsp`, `legalCsp`) | Task 1 |
| Part 2 — Worker HTML transform, import, `text/html` guard, `<meta>` strip, `<script>` nonce, CSP + `no-store` headers, legal-page branch | Task 2 steps 5-6 |
| Part 3 — `client/index.html` + `legal/*.html` unchanged | Not touched (explicit) — verified by `tests/client/src/csp.test.ts` still asserting the `<meta>` |
| Part 4 — `_headers` loses CSP line, keeps companions | Task 2 step 3 |
| Part 5 — `tests/src/csp.test.ts` new | Task 1 step 1 |
| Part 5 — `tests/client/src/csp.test.ts` trimmed | Task 2 step 1 |
| Part 5 — `tests/e2e/local/csp.spec.ts` unchanged | Explicit — not in any task's file list |
| Part 5 — `csp-built.spec.ts` extended | Task 2 step 9 |
| Part 5 — `live-sync.spec.ts` updated | Task 2 step 10 |
| Part 5 — manual/post-deploy JSD check | Task 4 step 3 |
| Part 6 — 1.60.3, CHANGELOG, TEST-COVERAGE, ROADMAP, v1.60.2 spec update | Task 3 |
| Part 6 — no What's New entry | Task 3 step 2 (stated), step 6 (warning noted as expected) |

No gaps.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step has literal code. The manual-check steps have literal commands.

**3. Type consistency:** `generateNonce(): string`, `appCsp(nonce: string): string`, `legalCsp(nonce: string): string` — same names and signatures in Task 1's Produces block, the Task 1 module code, the Task 1 test, Task 2's import (`from "./csp.js"`), and Task 2's usage (`generateNonce()`, `appCsp(nonce)`, `legalCsp(nonce)`). `HTMLRewriter().on(selector, {element}).transform(res)` returns a `Response` whose `.body`/`.status`/`.statusText`/`.headers` Task 2 reads — consistent with the Workers runtime API.
