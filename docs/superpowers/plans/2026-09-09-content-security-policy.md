# Content-Security-Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Content-Security-Policy (as a `<meta>` tag in the built HTML) plus the standard companion security headers (via a Cloudflare `_headers` file), with an allowlist that breaks nothing — GA, Turnstile, GitHub avatars, arbitrary markdown images, PDF/HTML/MD export, math, Mermaid, live collaboration all keep working.

**Architecture:** The CSP is a `<meta http-equiv="Content-Security-Policy">` tag in `client/index.html` so the whole `local` Playwright suite (which runs against `vite dev`, not Cloudflare) exercises it. `client/public/_headers` carries the header-only companions (`X-Frame-Options`, etc.) and an authoritative duplicate CSP header for production; a unit test asserts the two CSP strings are byte-identical. `/privacy` and `/terms` get a stricter standalone `<meta>` CSP in their `legal/*.html` templates. One inline `<script>` in `index.html` (mobile sidebar collapse) is pinned by its `sha256` hash.

**Tech Stack:** static HTML, Cloudflare Workers Assets `_headers`, Vitest (`unit` project, jsdom), Playwright (`local` + `collab` projects), Node `crypto` for the hash check.

**Spec:** `docs/superpowers/specs/2026-09-09-content-security-policy-design.md`

## Global Constraints

- The CSP `<meta>` value and the `_headers` `Content-Security-Policy:` value must be **byte-identical** — a unit test enforces this.
- **No `'unsafe-inline'` and no `'unsafe-eval'` in `script-src`.** The one inline script is allowed by hash `sha256-dvrkhVN+dXykZmzU3pQRkYg38F+aYnJ2WXnZwjPgC04=`.
- The `local` Playwright project runs against `vite dev` (`http://localhost:5275`), which does **not** process `_headers`. The `collab` project runs against `wrangler dev` (`http://localhost:8787`) started by `tests/scripts/e2e-collab.sh`, which does.
- `client/public/*` is copied verbatim to `client/dist/` by Vite. `client/public/_headers` → `client/dist/_headers`. `client/public/{privacy,terms}.html` are git-ignored and generated from `legal/*.html` by `scripts/generate-legal.mjs` (`prebuild` / `predev:client`).
- `npm run format` (Prettier) + `npm run typecheck` + `npm test` must pass before every commit. `.svelte` files are not Prettier-checked (no parser); `.html`, `.ts`, `.md` are.
- Component tests → `tests/client/src/components/*.test.ts`. DOM-using unit tests get `// @vitest-environment jsdom` as the first line.
- Behind-the-scenes hardening → **patch** bump to `1.60.2`: `package.json` + both `package-lock.json` `"version"` fields (hand-edit). `## [1.60.2] - <today>` CHANGELOG under a new `### Security` heading. **No** `whats-new-entries.ts` entry, no screenshot.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## The exact policy strings

**App CSP** (one line, no newlines, in both `index.html` `<meta>` and `_headers`):

```
default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'sha256-dvrkhVN+dXykZmzU3pQRkYg38F+aYnJ2WXnZwjPgC04=' https://challenges.cloudflare.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; upgrade-insecure-requests
```

**Legal-pages CSP** (`legal/privacy.html`, `legal/terms.html` `<meta>`):

```
default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'
```

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `client/index.html` | `<meta http-equiv="Content-Security-Policy">` in `<head>` | 1 |
| `client/public/_headers` (new) | Companion security headers + authoritative CSP header | 1 |
| `tests/client/src/csp.test.ts` (new) | Directive presence, inline-script hash recompute, `<meta>`↔`_headers` parity, legal-page CSP | 1, 2 |
| `legal/privacy.html`, `legal/terms.html` | Strict standalone `<meta>` CSP | 2 |
| `tests/e2e/local/csp.spec.ts` (new) | No-CSP-violation walkthrough incl. HTML/MD/PDF export | 3 |
| `tests/e2e/collab/live-sync.spec.ts` (modify) | One header assertion on `GET /` | 4 |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | `1.60.2` release + PR | 5 |

---

## Task 1: App CSP — `<meta>` tag + `_headers` file

**Files:**
- Modify: `client/index.html` (add `<meta>` after `<meta name="viewport">`)
- Create: `client/public/_headers`
- Test: `tests/client/src/csp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `<meta http-equiv="Content-Security-Policy" content="…">` in the served HTML; a `client/dist/_headers` with `Content-Security-Policy` + 5 companion headers. Later tasks re-parse both.

**Context:**
- `client/index.html` head order (lines 3–12): `<meta charset>`, `<meta name="viewport">`, `<title>`, `<meta name="description">`, `<meta name="theme-color">`, `<link rel="canonical">`. Insert the CSP `<meta>` immediately after the `viewport` line — before `<title>` and every `<link>`/`<meta property="og:*">` so it is in force before any tag that could trigger a fetch.
- The one inline `<script>` is around line 467, tagless (`<script>` with no attributes), containing `window.matchMedia("(max-width: 780px)")`. The module entry at the end (`<script type="module" src="/src/main.ts">`) has attributes and is `'self'`.
- Cloudflare `_headers` format: a path pattern line (no indent), then each header as `  Name: value` (two-space indent). `/*` matches everything.

- [ ] **Step 1: Write the failing test**

`tests/client/src/csp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(__dirname, "../../..");
const indexHtml = readFileSync(resolve(root, "client/index.html"), "utf8");
const headersFile = readFileSync(resolve(root, "client/public/_headers"), "utf8");

function metaCsp(html: string): string {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("no CSP <meta> found");
  return m[1]!;
}

function headerValue(headers: string, name: string): string | null {
  const m = headers.match(new RegExp(`^\\s{2}${name}:\\s*(.+)$`, "im"));
  return m ? m[1]!.trim() : null;
}

describe("app Content-Security-Policy", () => {
  const csp = metaCsp(indexHtml);

  it("names every directive the app needs", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toMatch(/script-src [^;]*'self'/);
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toMatch(/connect-src [^;]*'self'/);
    expect(csp).toContain("https://*.google-analytics.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("upgrade-insecure-requests");
    // the belt-and-braces items that block whole attack classes
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("allows the one inline script by its current hash", () => {
    const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const hash = createHash("sha256").update(scripts[0]![1]!, "utf8").digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  it("the _headers file's CSP is byte-identical to the <meta>", () => {
    expect(headerValue(headersFile, "Content-Security-Policy")).toBe(csp);
  });

  it("_headers carries the companion security headers", () => {
    expect(headerValue(headersFile, "X-Frame-Options")).toBe("DENY");
    expect(headerValue(headersFile, "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(headersFile, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headerValue(headersFile, "Permissions-Policy")).toContain("camera=()");
    expect(headerValue(headersFile, "Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("_headers applies the rules to every path", () => {
    expect(headersFile.split("\n")[0]!.trim()).toBe("/*");
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/client/src/csp.test.ts`
Expected: FAIL — `client/public/_headers` does not exist / no CSP `<meta>`.

- [ ] **Step 3: Add the `<meta>` to `client/index.html`**

After the `<meta name="viewport" ... />` line, before `<title>`:

```html
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'sha256-dvrkhVN+dXykZmzU3pQRkYg38F+aYnJ2WXnZwjPgC04=' https://challenges.cloudflare.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; upgrade-insecure-requests"
    />
```

> Prettier will reflow this — run `npm run format` before committing and let it; the test reads `content="..."` on one logical attribute regardless of source wrapping. If Prettier splits `content` across lines and breaks the regex, change the test's `metaCsp` regex to `/<meta\s+http-equiv="Content-Security-Policy"\s+content="([\s\S]+?)"\s*\/?>/i` and collapse whitespace: `.replace(/\s+/g, " ").trim()`. Verify after formatting.

- [ ] **Step 4: Create `client/public/_headers`**

```
/*
  Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'sha256-dvrkhVN+dXykZmzU3pQRkYg38F+aYnJ2WXnZwjPgC04=' https://challenges.cloudflare.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; upgrade-insecure-requests
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
```

Add `client/public/_headers` to `.prettierignore` (it is not valid for any Prettier parser and `prettier --check .` would choke on it):

```
# client/public/_headers is a Cloudflare directives file, not code
client/public/_headers
```

- [ ] **Step 5: Run the test, expect pass**

Run: `npx vitest run tests/client/src/csp.test.ts`
Expected: PASS (6).

- [ ] **Step 6: Build + typecheck + format**

```bash
npm run build && npm run typecheck && npm run format && npm run format:check
```
Expected: PASS. Confirm `client/dist/_headers` exists and `client/dist/index.html` contains the `<meta>`.
Then re-run the test (formatting may have reflowed the `<meta>`): `npx vitest run tests/client/src/csp.test.ts` — still PASS.

- [ ] **Step 7: Commit**

```bash
git add client/index.html client/public/_headers .prettierignore tests/client/src/csp.test.ts
git commit -m "$(cat <<'EOF'
feat(security): Content-Security-Policy meta tag + _headers companions

CSP lives in a <meta> in index.html so the vite-dev-based local e2e
suite runs under it; client/public/_headers carries X-Frame-Options,
nosniff, Referrer-Policy, Permissions-Policy, COOP and an authoritative
duplicate CSP header. A unit test keeps the two CSP strings identical
and pins the one inline script by hash.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Legal pages — strict standalone CSP

**Files:**
- Modify: `legal/privacy.html`, `legal/terms.html`
- Modify: `tests/client/src/csp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `<meta http-equiv="Content-Security-Policy">` in each legal page; after `npm run generate:legal` the same tag is in `client/public/{privacy,terms}.html`.

**Context:**
- `legal/privacy.html` / `legal/terms.html` head (lines 3–8): `<meta charset>`, `<meta name="viewport">`, `<title>`, `<link rel="canonical">`, `<meta name="robots">`, then a `<style>` block. These pages load zero JS.
- `scripts/generate-legal.mjs` reads each `legal/*.html`, runs `applyContact()` (a `<!--CONTACT-->` substitution), writes to `client/public/`. It does not otherwise transform the HTML, so a `<meta>` added to the template flows straight through.

- [ ] **Step 1: Add the failing assertions**

Append to `tests/client/src/csp.test.ts`:

```ts
describe("legal pages Content-Security-Policy", () => {
  const LEGAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'";

  for (const page of ["privacy", "terms"]) {
    it(`${page}.html carries the strict standalone CSP`, () => {
      const html = readFileSync(resolve(root, `legal/${page}.html`), "utf8");
      expect(metaCsp(html)).toBe(LEGAL_CSP);
    });
  }
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/client/src/csp.test.ts -t "legal pages"`
Expected: FAIL — no CSP `<meta>` in the legal templates.

- [ ] **Step 3: Add the `<meta>` to both templates**

In `legal/privacy.html` and `legal/terms.html`, immediately after `<meta name="viewport" ... />`:

```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'" />
```

- [ ] **Step 4: Regenerate + run**

```bash
npm run generate:legal
npx vitest run tests/client/src/csp.test.ts
```
Expected: PASS (8). Confirm `client/public/privacy.html` (git-ignored, regenerated) also has the tag: `grep -c Content-Security-Policy client/public/privacy.html` → `1`.

- [ ] **Step 5: format + commit**

```bash
npm run format
git add legal/privacy.html legal/terms.html tests/client/src/csp.test.ts
git commit -m "$(cat <<'EOF'
feat(security): strict standalone CSP on /privacy and /terms

These pages load no JavaScript — default-src 'none' with only inline
styles allowed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Local e2e — no-CSP-violation walkthrough

**Files:**
- Create: `tests/e2e/local/csp.spec.ts`

**Interfaces:**
- Consumes: the `<meta>` CSP shipped in Task 1 (present under `vite dev`).
- Produces: nothing.

**Context:**
- `tests/e2e/local/support/fixtures.ts` exports `test` / `expect` — it seeds one local doc + workspace and navigates to `/` (`baseURL` `http://localhost:5275`, `vite dev`, `VITE_DISABLE_API_PROXY=1`, no `VITE_GA_MEASUREMENT_ID`). Import from there, not `@playwright/test`.
- GA and Turnstile are **not** configured in this project, so this spec proves the CSP does not break the *core* app (editor, preview, math, Mermaid, images, export). GA/Turnstile allowlist verification is the manual pre-merge step (Spec Part 4) + Task 4's header check.
- Console-error capture pattern in the repo: `page.on("pageerror", …)` (see `tests/e2e/local/command-palette.spec.ts:64`). A CSP violation surfaces as a `console` message of type `error`, text like `Refused to load the script … because it violates … Content Security Policy`, **and** a `SecurityPolicyViolationEvent` — capture `page.on("console")`.
- The editor mount is `#editor-mount .cm-content`; the preview mount is `#preview-mount`. KaTeX output is `.katex`. A Mermaid fence renders a `<svg>` inside `#preview-mount .mermaid` (or `pre.mermaid` → replaced). Export lives under the File menu; `window.MDE.exportAs("md" | "html" | "pdf")` is the programmatic hook (see `client/src/app.ts:1028`+).

- [ ] **Step 1: Write the spec**

`tests/e2e/local/csp.spec.ts`:

```ts
import { test, expect } from "./support/fixtures";

const CSP_RE = /Content Security Policy|Refused to (load|execute|connect|apply|frame)/i;

test.describe("Content-Security-Policy does not break the app", () => {
  test("the CSP meta tag is present and enforcing", async ({ page }) => {
    const content = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(content).toMatch(/^default-src 'self'/);
    expect(content).toContain("object-src 'none'");
  });

  test("editing, math, Mermaid, images and menus produce no CSP violation", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && CSP_RE.test(m.text())) violations.push(m.text());
    });

    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await page.click("#editor-mount .cm-content");
    await page.evaluate(() => {
      const cm = window.MDE.getEditor();
      cm.dispatch({
        changes: {
          from: 0,
          to: cm.state.doc.length,
          insert:
            "# CSP probe\n\nInline math $x^2 + 1$ and a data image ![d](data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=) and a remote one ![r](https://raw.githubusercontent.com/Jerit3787/markdown-editor/master/client/public/logo.svg)\n\n```mermaid\ngraph TD; A-->B;\n```\n",
        },
      });
    });

    await expect(page.locator("#preview-mount .katex").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#preview-mount img[src^="data:"]').first()).toBeVisible();
    await expect(page.locator("#preview-mount .mermaid svg, #preview-mount svg[id^='mermaid']").first()).toBeVisible({ timeout: 10000 });

    // open the menus + command palette + settings
    for (const label of ["File", "Edit", "View", "Help"]) {
      await page.locator(`#menuBar >> text="${label}"`).click();
      await page.keyboard.press("Escape");
    }
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.press("Escape");

    expect(violations, `CSP violations:\n${violations.join("\n")}`).toEqual([]);
  });

  test("HTML / Markdown / PDF export run without a CSP script violation", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && CSP_RE.test(m.text())) violations.push(m.text());
    });
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await page.click("#editor-mount .cm-content");
    await page.evaluate(() => {
      const cm = window.MDE.getEditor();
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "# Export probe\n\nSome **bold** text.\n" } });
    });

    for (const fmt of ["md", "html"] as const) {
      const dl = page.waitForEvent("download", { timeout: 15000 });
      await page.evaluate((f) => window.MDE.exportAs(f), fmt);
      await dl;
    }
    // PDF pulls in html2pdf.js — the 'unsafe-eval' check.
    const pdf = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
    await page.evaluate(() => window.MDE.exportAs("pdf"));
    await pdf;

    expect(violations, `CSP violations during export:\n${violations.join("\n")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test --project=local csp`
Expected: PASS. If the PDF test logs `Refused to evaluate a string as JavaScript` / `unsafe-eval`, **stop** — add `'unsafe-eval'` to `script-src` in `client/index.html` **and** `client/public/_headers` with the comment `/* 'unsafe-eval' required by html2pdf.js/jspdf for PDF export */`, update the Task 1 test's `expect(csp).not.toContain("'unsafe-eval'")` to `expect(csp).toContain("'unsafe-eval'")`, re-run Task 1's unit test, then re-run this.
If `window.MDE.exportAs` is not the right hook, find the real export entry points in `client/src/app.ts` (search `exportAs` / the File-menu `#menuExport*` ids) and drive the menu instead.

- [ ] **Step 3: Verify the whole local suite still passes under the CSP**

Run: `npx playwright test --project=local`
Expected: PASS (was 202; now 202 + 3). Any *other* spec that starts failing with a CSP violation is a real allowlist gap — fix the policy in both places + the unit test, don't loosen blindly.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/local/csp.spec.ts
git commit -m "$(cat <<'EOF'
test(security): local e2e walkthrough asserts no CSP violation

Editing, inline math, a Mermaid diagram, data + remote images, every
menu, and HTML/Markdown/PDF export all run clean under the <meta> CSP.
The PDF path is the runtime 'unsafe-eval' check.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Collab e2e — production header assertion

**Files:**
- Modify: `tests/e2e/collab/live-sync.spec.ts`

**Interfaces:**
- Consumes: `client/dist/_headers` served by `wrangler dev` (Task 1).
- Produces: nothing.

**Context:**
- The `collab` project's `baseURL` is `http://localhost:8787` (`wrangler dev`, started by `tests/scripts/e2e-collab.sh` which builds the client first). `wrangler dev` serves `client/dist` and applies `_headers`.
- `tests/e2e/collab/live-sync.spec.ts` already has a test `"a live edit from one collaborator appears…"`. Add a small independent test to the same file — it needs no shared workspace, just one `GET /`.
- Playwright: `page.goto()` returns a `Response`; `response.headers()` is a lowercased-key object.

- [ ] **Step 1: Add the failing test**

At the end of `tests/e2e/collab/live-sync.spec.ts`:

```ts
test("the built app is served with the CSP and companion security headers", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const res = await page.goto("http://localhost:8787/");
  const h = res!.headers();
  expect(h["content-security-policy"]).toContain("default-src 'self'");
  expect(h["content-security-policy"]).toContain("frame-src https://challenges.cloudflare.com");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  await ctx.close();
});
```

- [ ] **Step 2: Run the collab suite**

Run: `npm run test:e2e:collab`
Expected: the new test PASSES (33 → 35 total with Task 3 not counted here; expect `35 passed` if prior was `34`). If `content-security-policy` is `undefined`, `wrangler dev` is not applying `_headers` — see the fallback in Step 3.

- [ ] **Step 3: If `wrangler dev` does not apply `_headers`**

Confirm with `curl -sI http://localhost:8787/ | grep -i content-security`. If absent:
- Change this test to `test.skip(true, "wrangler dev does not honor _headers; verified in production instead")` with a comment, and
- Add a note to the spec's "Open risks" #3 that the header path is verified only by a post-deploy `curl` (Task 5 Step 7).
The `<meta>` CSP (unit-tested + local-e2e-tested) still fully protects users; `_headers` is the production hardening layer and the unit parity test still guards its content.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/collab/live-sync.spec.ts
git commit -m "$(cat <<'EOF'
test(security): collab e2e checks the CSP + security response headers

The only path that exercises the real _headers file (wrangler dev),
not just the <meta> tag.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Release 1.60.2

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`

**Context:**
- `package.json` `"version"` is `1.60.1`; `package-lock.json` has two `"version": "1.60.1"` lines (~3, ~9).
- `CHANGELOG.md` newest section is `## [1.60.1] - 2026-09-09`. Keep a Changelog supports `### Security`.
- `docs/TEST-COVERAGE.md` highest SHELL row is `SHELL-37`.
- `ROADMAP.md` "Deferred considerations" has a line: `- [ ] A Content-Security-Policy — the app has none; adding GA (v1.57.0) didn't force one, but a CSP is worthwhile hardening on its own`.

- [ ] **Step 1: Version bump**

`package.json` + both `package-lock.json` lines → `1.60.2`.
Verify: `grep -n '"version": "1.60' package.json package-lock.json` → three `1.60.2`.

- [ ] **Step 2: CHANGELOG**

Insert above `## [1.60.1] - 2026-09-09` (use today's real date):

```markdown
## [1.60.2] - <today>

### Security

- Added a Content-Security-Policy plus the standard companion headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`). The page now refuses to load scripts, frames, or network connections from anywhere outside a short allowlist (self, Google Analytics, Cloudflare Turnstile), disallows inline/`eval` script entirely, and cannot be embedded in an iframe. No change to how the app behaves.
```

- [ ] **Step 3: TEST-COVERAGE**

Add after the `SHELL-37` row:

```markdown
| SHELL-38 | Content-Security-Policy — `client/index.html` carries a `<meta http-equiv>` CSP (`default-src 'self'`, `object-src 'none'`, no `'unsafe-inline'`/`'unsafe-eval'` in `script-src`, the one inline script pinned by a recomputed `sha256`); `client/public/_headers` repeats it byte-identically as a header and adds `X-Frame-Options: DENY` / `nosniff` / `Referrer-Policy` / `Permissions-Policy` / `COOP`; `/privacy` + `/terms` carry a stricter `default-src 'none'` `<meta>`. End-to-end: editing + inline math + Mermaid + data/remote images + every menu + HTML/MD/PDF export produce no CSP violation under `vite dev`; `wrangler dev` serves the header set | unit + e2e + e2e-collab | covered | `tests/client/src/csp.test.ts`, `tests/e2e/local/csp.spec.ts`, `tests/e2e/collab/live-sync.spec.ts` | v1.60.2 |
```

- [ ] **Step 4: ROADMAP**

Replace the deferred-considerations CSP line with:

```markdown
- [x] A Content-Security-Policy — **shipped v1.60.2** (spec
      `docs/superpowers/specs/2026-09-09-content-security-policy-design.md`).
      A `<meta>`-delivered CSP (`default-src 'self'`, allowlist: self + GA +
      Turnstile, no inline/eval script, one hashed inline snippet) plus
      `_headers` companions. Deferred: a `report-to` violation endpoint, a
      nonce-per-response pipeline, and Trusted Types.
```

- [ ] **Step 5: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
npx playwright test --project=local
npm run test:e2e:collab
```
Expected: all green.

- [ ] **Step 6: Commit + PR**

```bash
git add package.json package-lock.json CHANGELOG.md docs/TEST-COVERAGE.md ROADMAP.md
git commit -m "$(cat <<'EOF'
chore: release 1.60.2 — Content-Security-Policy

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin docs/csp-spec
gh pr create --title "Content-Security-Policy + companion security headers (v1.60.2)" --body "$(cat <<'EOF'
## What

A Content-Security-Policy for the app, delivered two ways:

- **`<meta http-equiv>` in `index.html`** — so the whole `local` Playwright suite (which runs under `vite dev`, not Cloudflare) is exercised by it.
- **`client/public/_headers`** — an authoritative duplicate CSP header plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. A unit test keeps the two CSP strings byte-identical.

**Policy:** `default-src 'self'`; no `'unsafe-inline'` / `'unsafe-eval'` in `script-src`; the one inline script (mobile sidebar collapse) pinned by `sha256`. Allowlist — `script-src`/`connect-src`: Google Analytics (`*.google-analytics.com`, `googletagmanager.com`) + Cloudflare Turnstile; `frame-src`: Turnstile's iframe; `img-src`: `'self' data: blob: https:` (markdown authors embed arbitrary images); `style-src 'unsafe-inline'` (Svelte / KaTeX / Mermaid runtime styles). `/privacy` + `/terms` get a stricter `default-src 'none'` `<meta>`.

## Tests

- `tests/client/src/csp.test.ts` — directive presence, inline-script hash recompute, `<meta>` ↔ `_headers` parity, legal-page CSP.
- `tests/e2e/local/csp.spec.ts` — editing + math + Mermaid + data/remote images + every menu + **HTML/MD/PDF export** produce no CSP violation (the PDF path is the runtime `'unsafe-eval'` check — none needed).
- `tests/e2e/collab/live-sync.spec.ts` — `wrangler dev` serves the CSP + companion headers.
- `npm test`, `typecheck`, `build`, `format:check`, `playwright --project=local`, `test:e2e:collab` all green.

## Release

Patch → **1.60.2**, `CHANGELOG.md` `### Security`, `docs/TEST-COVERAGE.md` SHELL-38, ROADMAP ticked. No What's New (invisible hardening).

## Manual check before merge

Built with `VITE_GA_MEASUREMENT_ID` + a real Turnstile key, in a real browser: GA `gtag/js` loads and `/g/collect` fires, an anonymous share renders the Turnstile widget, the signed-in GitHub avatar loads — all with no CSP violation.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Manual pre-merge check + production smoke**

Per Spec Part 4 "Manual". Then after merge + deploy:
```bash
curl -sI https://editor.danplace.tech/ | grep -iE "content-security-policy|x-frame-options|x-content-type|referrer-policy"
```
Expected: all five headers present. If the CSP header is missing but `X-Frame-Options` is present, `_headers` works but a CSP-header-specific issue exists — investigate; the `<meta>` still protects users.

- [ ] **Step 8: Watch CI, merge on green** (after user confirms).

---

## Self-Review

**1. Spec coverage:**
- Part 1 policy (every directive + rationale) → Task 1 Step 3/4 (verbatim string) + Task 1 test (directive presence). ✅
- Part 1 `/privacy` + `/terms` strict CSP → Task 2. ✅
- Part 2 inline-script hash + "test recomputes it" → Task 1 Step 1 test ("allows the one inline script by its current hash"). ✅
- Part 3 `_headers` file (5 companions + duplicate CSP + parity test) → Task 1 Steps 4 + test. ✅
- Part 3 "applies to SPA fallback + privacy/terms" → `/*` pattern (Task 1) + Task 4 header assertion. ✅
- Part 4 unit tests → Task 1 + 2 tests. ✅
- Part 4 local e2e (math, Mermaid, images, menus, **export incl. PDF/`unsafe-eval` check**, `<meta>` present) → Task 3. ✅
- Part 4 collab e2e header assertion → Task 4. ✅
- Part 4 manual (GA/Turnstile/avatar) → Task 5 Step 7. ✅
- Part 5 release (patch 1.60.2, `### Security`, no What's New, SHELL-38, ROADMAP) → Task 5. ✅
- Open risk 1 (`'unsafe-eval'`) → Task 3 Step 2 explicit stop-and-adjust procedure. ✅
- Open risk 3 (`wrangler dev` `_headers` support) → Task 4 Step 3 fallback. ✅

**2. Placeholder scan:** No "TBD" / "handle edge cases" / "similar to Task N". The CSP string is written verbatim in three places (Task 1 `<meta>`, Task 1 `_headers`, and the plan header) — deliberately, so an executor reading one task has it. `<today>` is fill-at-commit with "use today's real date". The `window.MDE.exportAs` hook has a "if this isn't right, find the real one" fallback because the exact export API name wasn't confirmed against source — acceptable, bounded, with a concrete search target.

**3. Type/name consistency:**
- The CSP string is identical in Task 1's `<meta>` (Step 3), Task 1's `_headers` (Step 4), and the plan header. The Legal CSP string is identical in Task 2 Step 1 (`LEGAL_CSP`) and Step 3.
- `sha256-dvrkhVN+dXykZmzU3pQRkYg38F+aYnJ2WXnZwjPgC04=` — same in the `<meta>`, `_headers`, the Global Constraints, and the plan header; Task 1's test recomputes and compares it rather than hard-coding.
- `metaCsp()` / `headerValue()` — defined in Task 1's test, reused by Task 2's appended block (same file).
- `CSP_RE` — defined once in Task 3's spec, used by two tests in it.
- Directive names (`script-src`, `connect-src`, `frame-src`, `worker-src`, `img-src`, `style-src`, `font-src`, `object-src`, `base-uri`, `manifest-src`, `form-action`) — consistent between the policy string, Task 1's assertions, and the CHANGELOG/TEST-COVERAGE copy.
- `SHELL-38` — Task 5 Step 3, referenced in the PR body.
- Version `1.60.2` — Global Constraints, Task 5 Steps 1/2, CHANGELOG heading, ROADMAP line, PR title.

No gaps found.
