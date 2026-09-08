# Analytics + standalone legal pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Terms and Privacy Policy as standalone `/terms` and `/privacy` pages (for Google OAuth verification later), and add opt-in Google Analytics 4 behind Consent Mode v2 and a consent banner.

**Architecture:** Two static HTML documents in `client/public/`, served at clean URLs by a new `src/worker.ts` route; the in-app modals are deleted and the About dialog links out. Analytics is a self-contained `client/src/analytics.ts` + a consent store + a `ConsentBanner.svelte` — nothing loads unless `import.meta.env.VITE_GA_MEASUREMENT_ID` is set at build time, and nothing non-essential fires until the visitor accepts.

**Tech Stack:** TypeScript, Svelte 5 runes, Cloudflare Worker (`src/worker.ts`), SCSS via `client/src/style.scss`, Vitest (`unit` jsdom + `components` headless-Chromium), Playwright (`local`).

**Spec:** `docs/superpowers/specs/2026-09-09-analytics-and-legal-pages-design.md`

## Global Constraints

- Production domain: `https://editor.danplace.tech`. Repo: `github.com/Jerit3787/markdown-editor`. Use these exact strings in the legal docs.
- GA loads **only** when `import.meta.env.VITE_GA_MEASUREMENT_ID` is a non-empty string at build time. Unset everywhere except the production Cloudflare build → zero GA code paths run, no network, no cookies.
- `track()` / `setSignedIn()` carry **no** free-form payload — the event name is an enum, the only user property is a yes/no boolean. Never send document names, contents, or the GitHub username.
- Two `tsconfig.json`s, checked separately. Svelte 5 runes only. Component tests → `tests/client/src/components/*.test.ts`.
- `npm run format` (Prettier) + `npm run typecheck` pass before every commit.
- Dark theme is `[data-theme="dark"]` (attribute, not media query).
- User-facing → **minor** bump to `1.57.0`: `package.json` + **both** `package-lock.json` `"version"` fields; `## [1.57.0] - <today>` CHANGELOG (`### Added` + `### Changed`); one `client/src/whats-new-entries.ts` entry with a real committed screenshot at `client/public/whats-new/analytics-consent.png`; `category` ∈ the 5 known values; `docs/TEST-COVERAGE.md` updated.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `client/public/privacy.html` (new) | full Privacy Policy document | 1 |
| `client/public/terms.html` (new) | full Terms of Service document | 1 |
| `src/worker.ts` | route `/privacy` `/terms` → the `.html` assets | 1 |
| `tests/src/worker.test.ts` | the two route assertions | 1 |
| `client/src/components/PrivacyModal.svelte`, `TermsModal.svelte` | **deleted** | 2 |
| `client/src/stores/aboutModals.ts` | drop `termsModalOpen` / `privacyModalOpen` | 2 |
| `client/src/components/AboutModal.svelte` | link out to `/terms` `/privacy` | 2 |
| `client/src/main.ts`, `client/index.html` | drop the two modal mounts | 2 |
| `client/public/sitemap.xml` | add `/privacy` `/terms` | 2 |
| `client/src/stores/analyticsConsent.ts` (new) | consent store + `initialConsent` + `setConsent` | 3 |
| `tests/client/src/stores/analyticsConsent.test.ts` (new) | consent-decision unit tests | 3 |
| `client/src/analytics.ts` (new) | `analyticsAvailable`, `initAnalytics`, `track`, `setSignedIn` | 4 |
| `tests/client/src/analytics.test.ts` (new) | unconfigured-no-op contract | 4 |
| `client/src/vite-env.d.ts` | type `VITE_GA_MEASUREMENT_ID` | 4 |
| `client/src/components/ConsentBanner.svelte` (new) | the opt-in bar | 5 |
| `client/src/styles/_consent-banner.scss` (new) | its styles | 5 |
| `client/src/style.scss`, `client/index.html`, `client/src/main.ts` | register + mount + `initAnalytics()` + palette-open track | 5 |
| `tests/client/src/components/ConsentBanner.test.ts` (new) | banner behaviour | 5 |
| `client/src/components/Settings.svelte` | Analytics On/Off row | 6 |
| `tests/client/src/components/Settings.test.ts` | Analytics-row test | 6 |
| `client/src/collab.ts`, `client/src/gist.ts`, `client/src/components/RepoLinkModal.svelte`, `client/src/app.ts` | 4 `track()` call sites | 6 |
| `tests/e2e/local/legal-and-consent.spec.ts` (new) | About-link href + no banner in the GA-less build | 6 |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/analytics-consent.png`, `tests/scripts/manual-testing/capture-analytics-consent-screenshot.mjs` (new), `CONTRIBUTING.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | release | 7 |

---

## Task 1: legal documents + worker routes

**Files:**
- Create: `client/public/privacy.html`, `client/public/terms.html`
- Modify: `src/worker.ts` (add a route block before the `return env.ASSETS.fetch(request)` fallthrough, ~line 161)
- Test: `tests/src/worker.test.ts`

**Interfaces:**
- Produces: `GET /privacy` and `GET /terms` (and trailing-slash variants) serve the `.html` documents.

**Context:**
- `src/worker.ts`'s `fetch` ends with a run of `if (url.pathname === …) return handle…()` checks then `return env.ASSETS.fetch(request);`. `run_worker_first: true` (wrangler.jsonc) means this runs before Cloudflare's SPA fallback, so an explicit route here wins.
- `tests/src/worker.test.ts` uses `fakeEnv()` → `ASSETS.fetch` is a `vi.fn()` returning `new Response("<!doctype html><title>app</title>", { status: 200, headers: { "Content-Type": "text/html" } })`. Assert on **which URL** `assetsFetch` was called with.
- `client/public/*` files are copied verbatim into `client/dist/` by `vite build` and served by `env.ASSETS`.

- [ ] **Step 1: Write the failing worker test**

In `tests/src/worker.test.ts`, inside `describe("worker routing", …)`, add:

```ts
it("serves the privacy document at /privacy (and /privacy/)", async () => {
  for (const path of ["/privacy", "/privacy/"]) {
    const { env, assetsFetch } = fakeEnv();
    await worker.fetch(new Request(`https://app.example.com${path}`), env);
    expect(assetsFetch).toHaveBeenCalledTimes(1);
    expect(assetsFetch.mock.calls[0][0].url).toBe("https://app.example.com/privacy.html");
  }
});

it("serves the terms document at /terms", async () => {
  const { env, assetsFetch } = fakeEnv();
  await worker.fetch(new Request("https://app.example.com/terms"), env);
  expect(assetsFetch.mock.calls[0][0].url).toBe("https://app.example.com/terms.html");
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/src/worker.test.ts -t "privacy document"`
Expected: FAIL — `assetsFetch` called with `.../privacy`, not `.../privacy.html`.

- [ ] **Step 3: Add the route**

In `src/worker.ts`, immediately before `return env.ASSETS.fetch(request);`:

```ts
    // Terms / Privacy are standalone documents (client/public/*.html),
    // served at clean URLs — the stable links Google's OAuth consent
    // screen points at. This must run before the SPA asset fallback,
    // which would otherwise hand back index.html.
    const legalMatch = url.pathname.match(/^\/(privacy|terms)\/?$/);
    if (legalMatch) {
      return env.ASSETS.fetch(new Request(new URL(`/${legalMatch[1]}.html`, url), request));
    }
```

- [ ] **Step 4: Run the worker test, expect pass**

Run: `npx vitest run tests/src/worker.test.ts`
Expected: PASS (the two new tests + all existing SHELL-21 tests).

- [ ] **Step 5: Create `client/public/privacy.html`**

Structure — a full HTML document with an inline `<style>` and the body content being the **Privacy Policy text from the spec's "`client/public/privacy.html` — content" block, verbatim** (11 numbered sections). Skeleton:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Privacy Policy — Markdown Editor</title>
    <link rel="canonical" href="https://editor.danplace.tech/privacy" />
    <meta name="robots" content="index, follow" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 48px 20px 96px;
        font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #1f2328;
        background: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        body { color: #e6e6e6; background: #1e1f22; }
        a { color: #4d8dff; }
      }
      .doc { max-width: 720px; margin: 0 auto; }
      .brand { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; font-weight: 700; margin-bottom: 32px; }
      .brand span { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; background: #2563eb; color: #fff; font-size: 13px; }
      h1 { font-size: 26px; margin: 0 0 4px; }
      .updated { color: #6b7280; font-size: 14px; margin: 0 0 32px; }
      h2 { font-size: 18px; margin: 32px 0 8px; }
      a { color: #2563eb; }
      p { margin: 0 0 12px; }
    </style>
  </head>
  <body>
    <div class="doc">
      <a class="brand" href="/"><span>Md</span> Markdown Editor</a>
      <h1>Privacy Policy</h1>
      <p class="updated">Last updated: 2026-09-09</p>
      <!-- the spec's 11 sections: an intro <p>, then <h2>1. …</h2> + <p> per section -->
    </div>
  </body>
</html>
```

Render each spec section as `<h2>N. Heading</h2>` followed by its paragraph(s); the markdown links in the spec (`[Google's Privacy Policy](https://…)`, the GitHub issues link) become real `<a href … target="_blank" rel="noopener">`.

- [ ] **Step 6: Create `client/public/terms.html`**

Same skeleton (title "Terms of Service — Markdown Editor", canonical `/terms`), body = the spec's "`client/public/terms.html` — content" block verbatim (8 sections).

- [ ] **Step 7: Verify the build copies them**

Run: `npm run build && ls client/dist/privacy.html client/dist/terms.html`
Expected: both listed.

- [ ] **Step 8: Manual read-through**

`npm run dev` (wrangler, :8787), open `http://localhost:8787/privacy` and `/terms`. Read every line. Confirm: links work, the "Md" wordmark returns to `/`, dark mode renders, no broken markup. Fix any typo now.

- [ ] **Step 9: Commit**

```bash
npm run format
git add client/public/privacy.html client/public/terms.html src/worker.ts tests/src/worker.test.ts
git commit -m "$(cat <<'EOF'
feat(legal): standalone /privacy and /terms pages

Full Privacy Policy and Terms of Service as self-contained HTML
documents, served at clean URLs by the Worker (before the SPA
fallback). These are the stable links Google's OAuth verification
will point at.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: retire the modals, link out

**Files:**
- Delete: `client/src/components/PrivacyModal.svelte`, `client/src/components/TermsModal.svelte`
- Modify: `client/src/stores/aboutModals.ts`, `client/src/components/AboutModal.svelte`, `client/src/main.ts`, `client/index.html`, `client/public/sitemap.xml`
- Test: covered by the existing About flow + Task 6's e2e; add a `topbar-tooltip`-style source check.

**Interfaces:**
- Consumes: `/privacy`, `/terms` routes (Task 1).
- Produces: `aboutModals.ts` no longer exports `termsModalOpen` / `privacyModalOpen`.

**Context:**
- `client/src/stores/aboutModals.ts` currently exports `aboutModalOpen`, `termsModalOpen`, `privacyModalOpen`, `licensesModalOpen`.
- `AboutModal.svelte` imports all four, has `openTerms()` / `openPrivacy()` that `close()` then set the store, and renders two `<button class="menu-link-item" onclick={openTerms/openPrivacy}>`.
- `main.ts` lines ~50-52 import `TermsModal` / `PrivacyModal`; lines ~86-87 `mount()` them. `LicensesModal` stays.
- `client/index.html` ~685-687: `<div id="about-modal-mount">`, `<div id="terms-modal-mount">`, `<div id="privacy-modal-mount">` with a comment ~682-684 naming all four components.
- No other file references `termsModalOpen` / `privacyModalOpen` (verified: only `AboutModal.svelte`, the two modal components, and the store).

- [ ] **Step 1: Write the failing source check**

Create `tests/client/src/about-links.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const about = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../client/src/components/AboutModal.svelte"),
  "utf8",
);

describe("About modal legal links", () => {
  it("links out to /terms and /privacy in a new tab", () => {
    expect(about).toMatch(/href="\/terms"[^>]*target="_blank"/);
    expect(about).toMatch(/href="\/privacy"[^>]*target="_blank"/);
  });
  it("no longer references the deleted modal stores", () => {
    expect(about).not.toContain("termsModalOpen");
    expect(about).not.toContain("privacyModalOpen");
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/client/src/about-links.test.ts`
Expected: FAIL — the modal still uses `<button onclick={openTerms}>`.

- [ ] **Step 3: Rewrite `AboutModal.svelte`**

- Script: change the import to `import { aboutModalOpen, licensesModalOpen } from "../stores/aboutModals";`. Delete `openTerms` and `openPrivacy`. Keep `openLicenses`.
- Template: replace the two Terms/Privacy `<button>`s with:
  ```svelte
  <a class="menu-link-item" href="/terms" target="_blank" rel="noopener">
    <svg class="icon"><use href="#icon-file"></use></svg> Terms of Service
  </a>
  <a class="menu-link-item" href="/privacy" target="_blank" rel="noopener">
    <svg class="icon"><use href="#icon-lock"></use></svg> Privacy Policy
  </a>
  ```
  (The existing "View Source on GitHub" row is already this exact `<a class="menu-link-item">` shape.)

- [ ] **Step 4: Prune the store**

`client/src/stores/aboutModals.ts` →

```ts
import { writable } from "svelte/store";

export const aboutModalOpen = writable(false);
export const licensesModalOpen = writable(false);
```

- [ ] **Step 5: Delete the components + mounts**

```bash
git rm client/src/components/PrivacyModal.svelte client/src/components/TermsModal.svelte
```
In `client/src/main.ts`: delete the `import TermsModal …` / `import PrivacyModal …` lines and the two `mount(TermsModal, …)` / `mount(PrivacyModal, …)` lines.
In `client/index.html`: delete `<div id="terms-modal-mount"></div>` and `<div id="privacy-modal-mount"></div>`; update the comment above to name only `AboutModal.svelte` and `LicensesModal.svelte`.

- [ ] **Step 6: sitemap**

`client/public/sitemap.xml` — add before `</urlset>`:

```xml
  <url>
    <loc>https://editor.danplace.tech/privacy</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://editor.danplace.tech/terms</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
```

- [ ] **Step 7: Run tests + typecheck + build**

```bash
npx vitest run tests/client/src/about-links.test.ts
npm test
npm run typecheck
npm run build
```
Expected: all PASS. (`svelte-check` will flag any missed reference to the deleted components/stores.)

- [ ] **Step 8: Commit**

```bash
npm run format
git add -A
git commit -m "$(cat <<'EOF'
refactor(legal): About links to /terms and /privacy; drop the modals

PrivacyModal / TermsModal deleted — the standalone pages are the single
source of truth. About opens them in a new tab. sitemap.xml updated.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: the consent store

**Files:**
- Create: `client/src/stores/analyticsConsent.ts`
- Test: `tests/client/src/stores/analyticsConsent.test.ts`

**Interfaces:**
- Produces:
  - `type Consent = "granted" | "denied" | "unset"`
  - `initialConsent(): Consent` — DNT / GPC → `"denied"`; else the stored value or `"unset"`.
  - `analyticsConsent: Writable<Consent>` (initialised to `initialConsent()`)
  - `setConsent(next: "granted" | "denied"): void` — sets the store + persists to `localStorage` key `mde:analyticsConsent`.

**Context:**
- The `unit` test project runs in jsdom; `navigator.doNotTrack` and `localStorage` are present and settable (`Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true })`).
- Match the repo's other tiny stores (`stores/settingsModal.ts`, `stores/github.ts`).

- [ ] **Step 1: Write the failing tests**

`tests/client/src/stores/analyticsConsent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";

const KEY = "mde:analyticsConsent";

async function freshModule() {
  vi.resetModules();
  return import("../../../../client/src/stores/analyticsConsent");
}

describe("analyticsConsent", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "doNotTrack", { value: null, configurable: true });
    delete (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl;
  });
  afterEach(() => vi.resetModules());

  it("is 'unset' with nothing stored and no privacy signal", async () => {
    const m = await freshModule();
    expect(m.initialConsent()).toBe("unset");
  });

  it("reads a stored 'granted' / 'denied'", async () => {
    localStorage.setItem(KEY, "granted");
    expect((await freshModule()).initialConsent()).toBe("granted");
    localStorage.setItem(KEY, "denied");
    vi.resetModules();
    expect((await freshModule()).initialConsent()).toBe("denied");
  });

  it("treats a garbage stored value as 'unset'", async () => {
    localStorage.setItem(KEY, "maybe");
    expect((await freshModule()).initialConsent()).toBe("unset");
  });

  it("Do-Not-Track forces 'denied' regardless of storage", async () => {
    localStorage.setItem(KEY, "granted");
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    expect((await freshModule()).initialConsent()).toBe("denied");
  });

  it("Global Privacy Control forces 'denied'", async () => {
    (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl = true;
    expect((await freshModule()).initialConsent()).toBe("denied");
  });

  it("setConsent updates the store and persists", async () => {
    const m = await freshModule();
    m.setConsent("granted");
    expect(get(m.analyticsConsent)).toBe("granted");
    expect(localStorage.getItem(KEY)).toBe("granted");
  });

  it("setConsent survives a localStorage failure", async () => {
    const m = await freshModule();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => m.setConsent("denied")).not.toThrow();
    expect(get(m.analyticsConsent)).toBe("denied");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/client/src/stores/analyticsConsent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the store** — verbatim from the spec's "B2" code block.

- [ ] **Step 4: Run the tests, expect pass**

Run: `npx vitest run tests/client/src/stores/analyticsConsent.test.ts`
Expected: PASS (8).

- [ ] **Step 5: Commit**

```bash
npm run format && npm run typecheck
git add client/src/stores/analyticsConsent.ts tests/client/src/stores/analyticsConsent.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): consent store — DNT/GPC-aware, localStorage-backed

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: the analytics module

**Files:**
- Create: `client/src/analytics.ts`
- Modify: `client/src/vite-env.d.ts`
- Test: `tests/client/src/analytics.test.ts`

**Interfaces:**
- Consumes: `analyticsConsent` from `./stores/analyticsConsent` (Task 3).
- Produces:
  - `analyticsAvailable: boolean` (`!!GA_ID`)
  - `initAnalytics(): void` — call once at startup.
  - `type AnalyticsEvent = "shared_workspace" | "published_gist" | "linked_repo" | "exported_doc" | "opened_command_palette"`
  - `track(event: AnalyticsEvent): void` — no-op unless configured AND consent granted.
  - `setSignedIn(signedIn: boolean): void` — same gating.

**Context:**
- `import.meta.env.VITE_GA_MEASUREMENT_ID` is `undefined` in both Vitest projects (nothing sets it). So `analyticsAvailable === false` and every function is a no-op in tests — that's the contract this task locks in.
- `__APP_VERSION__` is a global `define`d only in the production client build and the `components` Vitest project — **not** the `unit` project. `analytics.ts` references it only inside `loadGaScript()`, which only runs when `GA_ID` is set, which never happens in `unit` tests. Safe, but keep the reference inside that function (don't hoist it to module scope).

- [ ] **Step 1: Type the env var**

In `client/src/vite-env.d.ts`, after the `/// <reference types="vite/client" />` line:

```ts
interface ImportMetaEnv {
  readonly VITE_GA_MEASUREMENT_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 2: Write the failing test**

`tests/client/src/analytics.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { analyticsAvailable, initAnalytics, track, setSignedIn } from "../../../client/src/analytics";

describe("analytics (unconfigured — the test/self-host default)", () => {
  beforeEach(() => {
    delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
    document.head.querySelectorAll("script[src*='googletagmanager']").forEach((s) => s.remove());
  });

  it("reports itself unavailable when no measurement id is set", () => {
    expect(analyticsAvailable).toBe(false);
  });

  it("initAnalytics / track / setSignedIn are all no-ops — no dataLayer, no script", () => {
    initAnalytics();
    track("exported_doc");
    setSignedIn(true);
    expect((window as unknown as { dataLayer?: unknown[] }).dataLayer).toBeUndefined();
    expect(document.head.querySelector("script[src*='googletagmanager']")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `npx vitest run tests/client/src/analytics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create the module** — verbatim from the spec's "B3" code block (including the `analyticsAvailable` export added in the spec's self-review).

- [ ] **Step 5: Run the test, expect pass**

Run: `npx vitest run tests/client/src/analytics.test.ts`
Expected: PASS (2).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run format && npm run typecheck
git add client/src/analytics.ts client/src/vite-env.d.ts tests/client/src/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): GA4 module — Consent Mode v2, enum-only event API

analyticsAvailable / initAnalytics / track / setSignedIn. Zero code
paths execute unless VITE_GA_MEASUREMENT_ID is set at build time; track()
also no-ops until consent is granted. The event name is an enum and the
only user property is a yes/no boolean — nothing identifying can be sent.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: the consent banner

**Files:**
- Create: `client/src/components/ConsentBanner.svelte`, `client/src/styles/_consent-banner.scss`
- Modify: `client/src/style.scss`, `client/index.html`, `client/src/main.ts`
- Test: `tests/client/src/components/ConsentBanner.test.ts`

**Interfaces:**
- Consumes: `analyticsAvailable`, `initAnalytics` from `../analytics`; `analyticsConsent`, `setConsent` from `../stores/analyticsConsent`.
- Produces: a `<div id="consent-banner-mount">` consumer; a `.consent-banner` element with `Accept` / `Decline` buttons and a `/privacy` link, shown only when `analyticsAvailable && $analyticsConsent === "unset"`.

**Context:**
- `analyticsAvailable` is `false` in the `components` project too → the banner test must mock it. `vi.mock("../../../../client/src/analytics", …)` with `analyticsAvailable: true` and stub `initAnalytics`.
- `style.scss` is a flat `@use "./styles/<name>";` list; add `tooltip`-style near the end (before `utilities` / `print`).
- Toast stack is `z-index: 200`; the banner uses `z-index: 250`.
- `main.ts` mounts are a flat `mount(Component, { target: … })` list.

- [ ] **Step 1: Write the failing test**

`tests/client/src/components/ConsentBanner.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

vi.mock("../../../../client/src/analytics", () => ({
  analyticsAvailable: true,
  initAnalytics: vi.fn(),
}));

import ConsentBanner from "../../../../client/src/components/ConsentBanner.svelte";
import { analyticsConsent, setConsent } from "../../../../client/src/stores/analyticsConsent";

beforeEach(() => {
  analyticsConsent.set("unset");
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

test("renders when consent is unset, with Accept / Decline and a privacy link", async () => {
  const screen = await render(ConsentBanner);
  await expect.element(screen.getByRole("button", { name: /accept/i })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /decline/i })).toBeVisible();
  const link = screen.container.querySelector('a[href="/privacy"]');
  expect(link).not.toBeNull();
});

test("Accept sets consent granted and hides the banner", async () => {
  const screen = await render(ConsentBanner);
  await screen.getByRole("button", { name: /accept/i }).click();
  expect(get(analyticsConsent)).toBe("granted");
  await expect.poll(() => screen.container.querySelector(".consent-banner")).toBeNull();
});

test("Decline sets consent denied and hides the banner", async () => {
  const screen = await render(ConsentBanner);
  await screen.getByRole("button", { name: /decline/i }).click();
  expect(get(analyticsConsent)).toBe("denied");
  await expect.poll(() => screen.container.querySelector(".consent-banner")).toBeNull();
});

test("never renders once a choice is already made", async () => {
  analyticsConsent.set("granted");
  const screen = await render(ConsentBanner);
  expect(screen.container.querySelector(".consent-banner")).toBeNull();
});
```

Plus a second file `tests/client/src/components/ConsentBanner.unavailable.test.ts` (separate so the mock differs):

```ts
import { test, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";

vi.mock("../../../../client/src/analytics", () => ({ analyticsAvailable: false, initAnalytics: vi.fn() }));

import ConsentBanner from "../../../../client/src/components/ConsentBanner.svelte";
import { analyticsConsent } from "../../../../client/src/stores/analyticsConsent";

test("never renders when analytics is unavailable, even if consent is unset", async () => {
  analyticsConsent.set("unset");
  const screen = await render(ConsentBanner);
  expect(screen.container.querySelector(".consent-banner")).toBeNull();
});
```

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run --project=components tests/client/src/components/ConsentBanner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `ConsentBanner.svelte`**

```svelte
<script lang="ts">
  import { analyticsAvailable } from "../analytics";
  import { analyticsConsent, setConsent } from "../stores/analyticsConsent";

  const show = $derived(analyticsAvailable && $analyticsConsent === "unset");
</script>

{#if show}
  <div class="consent-banner" role="region" aria-label="Analytics consent">
    <p class="consent-banner-text">
      We use privacy-respecting analytics to see which features get used. No document content is ever collected.
      <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>
    </p>
    <div class="consent-banner-actions">
      <button type="button" class="secondary-btn" onclick={() => setConsent("denied")}>Decline</button>
      <button type="button" class="primary-btn" onclick={() => setConsent("granted")}>Accept</button>
    </div>
  </div>
{/if}
```

- [ ] **Step 4: Create `_consent-banner.scss`**

```scss
.consent-banner {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 250;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  justify-content: center;
  padding: 12px 20px;
  background: var(--bg);
  border-top: 1px solid var(--border);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.08);
  font-size: 13px;
  color: var(--text);
}
.consent-banner-text {
  margin: 0;
  max-width: 640px;
}
.consent-banner-text a {
  color: var(--accent);
}
.consent-banner-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.consent-banner-actions button {
  width: auto;
  margin: 0;
  padding: 6px 14px;
  font-size: 13px;
}
@media (prefers-reduced-motion: no-preference) {
  .consent-banner {
    animation: consent-slide-up 0.2s ease-out;
  }
  @keyframes consent-slide-up {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
}
```

- [ ] **Step 5: Register + mount + init**

- `client/src/style.scss` — add `@use "./styles/consent-banner";` (near `@use "./styles/tooltip";`).
- `client/index.html` — add `<div id="consent-banner-mount"></div>` next to the other mount points (e.g. after `<div id="toast-mount"></div>`).
- `client/src/main.ts`:
  ```ts
  import ConsentBanner from "./components/ConsentBanner.svelte";
  import { initAnalytics } from "./analytics";
  import { commandPaletteOpen } from "./stores/commandPalette";
  import { track } from "./analytics";
  ```
  After the store imports / near the top of the mount block:
  ```ts
  initAnalytics();
  mount(ConsentBanner, { target: document.getElementById("consent-banner-mount")! });
  // opened_command_palette — the one event that's cleanly store-driven.
  let paletteSeen = false;
  commandPaletteOpen.subscribe((open) => {
    if (open && !paletteSeen) {
      paletteSeen = true;
      track("opened_command_palette");
    }
    if (!open) paletteSeen = false;
  });
  ```
  (`track` no-ops until consent + GA are both live, so this is safe to wire unconditionally.)

- [ ] **Step 6: Run the component tests, expect pass**

Run: `npx vitest run --project=components tests/client/src/components/ConsentBanner.test.ts tests/client/src/components/ConsentBanner.unavailable.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full unit + typecheck + build**

```bash
npm test && npm run typecheck && npm run build
```
Expected: PASS. (`main.ts` is excluded from coverage; the subscribe wiring has no test — it's one line, verified in Task 6's e2e that the banner is absent in the GA-less build.)

- [ ] **Step 8: Commit**

```bash
npm run format
git add client/src/components/ConsentBanner.svelte client/src/styles/_consent-banner.scss client/src/style.scss client/index.html client/src/main.ts tests/client/src/components/ConsentBanner.test.ts tests/client/src/components/ConsentBanner.unavailable.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): opt-in consent banner + startup wiring

ConsentBanner.svelte shows once (only when GA is configured and consent
is unset); Accept/Decline write the consent store. main.ts calls
initAnalytics() and tracks command-palette opens.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Settings toggle + event call sites + e2e

**Files:**
- Modify: `client/src/components/Settings.svelte`, `client/src/collab.ts`, `client/src/gist.ts`, `client/src/components/RepoLinkModal.svelte`, `client/src/app.ts`
- Test: `tests/client/src/components/Settings.test.ts`, `tests/e2e/local/legal-and-consent.spec.ts` (new)

**Interfaces:**
- Consumes: `analyticsAvailable` from `../analytics`; `analyticsConsent`, `setConsent`, `initialConsent` from `../stores/analyticsConsent`; `track` / `setSignedIn` from `../analytics`.

**Context:**
- `Settings.svelte` renders `.setting-row` blocks; the GitHub row is the pattern to sit next to (label + desc + a control). The Keybindings row uses a `.tab-switch` with `role="tablist"` and `.tab-switch-btn` children.
- `Settings.test.ts` already stubs `window.MDE` and `localStorage`. It drives the modal via `settingsModalOpen` (from v1.56.0).
- `track()` anchors (verified line numbers may drift — search the described string):
  - **`exported_doc`** — `client/src/app.ts`, `async function exportAs(format: string)` (~line 1019), the first line after `saveNow();`.
  - **`published_gist`** — `client/src/gist.ts`, in `publish()`, the `!wasUpdate` success path: right after `finishProgressToast(progressToastId, wasUpdate ? "Gist updated" : "Published to Gist", "success");` add `if (!wasUpdate) track("published_gist");`.
  - **`linked_repo`** — `client/src/components/RepoLinkModal.svelte`, right after `finishProgressToast(progressToastId, `Linked to ${owner}/${repo}`, "success");` (~line 55).
  - **`shared_workspace`** — `client/src/collab.ts`, `setAccessMode(...)`: capture `const wasUnshared = !workspaceRoom.workspaceId;` near the top (after the `getActiveDoc` guard), and near the end (after `showToast(ACCESS_MODE_TOAST[mode], "info");`) add `if (wantAnyone && wasUnshared) track("shared_workspace");`. Also in `addPerson(...)`: after its success toast, `if (!workspaceRoom.workspaceId === false) { … }` — simpler: track only in `setAccessMode` for v1; `addPerson`-only shares are rarer. **Decision: instrument `setAccessMode` only.**
- **`setSignedIn`** — `client/src/gist.ts`, `render()` sets `githubUsernameStore.set(connectedUsername)` (~line 77). Add `setSignedIn(!!connectedUsername);` right after.

- [ ] **Step 1: Write the failing Settings test**

Add to `tests/client/src/components/Settings.test.ts`:

```ts
import { analyticsConsent } from "../../../../client/src/stores/analyticsConsent";

test("v1.57: no Analytics row when analytics is unavailable", async () => {
  settingsModalOpen.set(true);
  const screen = await render(Settings);
  await expect.poll(() => screen.container.textContent).toContain("Appearance");
  expect(screen.container.textContent).not.toContain("Analytics");
});
```

(The available-path is covered by mocking `analyticsAvailable` — add a second file `Settings.analytics.test.ts` mirroring the `ConsentBanner.test.ts` mock approach, asserting the row appears and toggling calls `setConsent`.)

`tests/client/src/components/Settings.analytics.test.ts`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

vi.mock("../../../../client/src/analytics", () => ({ analyticsAvailable: true, initAnalytics: vi.fn(), track: vi.fn(), setSignedIn: vi.fn() }));

import Settings from "../../../../client/src/components/Settings.svelte";
import { settingsModalOpen } from "../../../../client/src/stores/settingsModal";
import { analyticsConsent } from "../../../../client/src/stores/analyticsConsent";

beforeEach(() => {
  settingsModalOpen.set(true);
  analyticsConsent.set("unset");
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  localStorage.clear();
});

test("shows an Analytics On/Off control reflecting consent, and toggling it sets consent", async () => {
  const screen = await render(Settings);
  await expect.element(screen.getByText("Analytics")).toBeVisible();
  await screen.getByRole("tab", { name: /^on$/i }).click();
  expect(get(analyticsConsent)).toBe("granted");
  await screen.getByRole("tab", { name: /^off$/i }).click();
  expect(get(analyticsConsent)).toBe("denied");
});
```

- [ ] **Step 2: Run them, expect failure**

Run: `npx vitest run --project=components tests/client/src/components/Settings.test.ts tests/client/src/components/Settings.analytics.test.ts`
Expected: FAIL — no Analytics row.

- [ ] **Step 3: Add the Analytics row to `Settings.svelte`**

Script: `import { analyticsAvailable } from "../analytics";` and `import { analyticsConsent, setConsent } from "../stores/analyticsConsent";`.

Template — after the GitHub `.setting-row`:

```svelte
{#if analyticsAvailable}
  <div class="setting-row">
    <div class="setting-label">
      <span class="setting-title">Analytics</span>
      <span class="setting-desc">Help improve the app by sharing anonymous, content-free usage data.</span>
    </div>
    <div class="tab-switch" role="tablist" aria-label="Analytics" style="margin: 0; min-width: 140px;">
      <button
        type="button"
        class="tab-switch-btn"
        class:active={$analyticsConsent === "granted"}
        role="tab"
        aria-selected={$analyticsConsent === "granted"}
        onclick={() => setConsent("granted")}
      >
        On
      </button>
      <button
        type="button"
        class="tab-switch-btn"
        class:active={$analyticsConsent !== "granted"}
        role="tab"
        aria-selected={$analyticsConsent !== "granted"}
        onclick={() => setConsent("denied")}
      >
        Off
      </button>
    </div>
  </div>
{/if}
```

(DNT/GPC already forces `$analyticsConsent === "denied"` via `initialConsent()`, so the toggle simply shows Off; a disabled-with-note refinement is deferred — YAGNI for v1.)

- [ ] **Step 4: Run the Settings tests, expect pass**

Run: `npx vitest run --project=components tests/client/src/components/Settings.test.ts tests/client/src/components/Settings.analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `track()` / `setSignedIn` call sites**

Per the anchors in **Context** above:
- `app.ts` — `import { track } from "./analytics";` (top), `track("exported_doc");` first line of `exportAs`.
- `gist.ts` — `import { track, setSignedIn } from "./analytics";`; `if (!wasUpdate) track("published_gist");` after the published toast; `setSignedIn(!!connectedUsername);` after `githubUsernameStore.set(connectedUsername)`.
- `RepoLinkModal.svelte` — `import { track } from "../analytics";`; `track("linked_repo");` after the "Linked to" toast.
- `collab.ts` — `import { track } from "./analytics";`; in `setAccessMode`, `const wasUnshared = !workspaceRoom.workspaceId;` after the `getActiveDoc` guard, and `if (wantAnyone && wasUnshared) track("shared_workspace");` after the `ACCESS_MODE_TOAST` toast.

- [ ] **Step 6: Write the e2e**

`tests/e2e/local/legal-and-consent.spec.ts`:

```ts
import { test, expect } from "./support/fixtures";

test("v1.57: About links out to the standalone legal pages", async ({ page }) => {
  await page.click("#helpMenuBtn");
  await page.click("#menuInfo");
  await expect(page.locator('a[href="/terms"][target="_blank"]')).toBeVisible();
  await expect(page.locator('a[href="/privacy"][target="_blank"]')).toBeVisible();
});

test("v1.57: no consent banner in a build without a GA measurement id", async ({ page }) => {
  // The local suite builds/serves the client with VITE_GA_MEASUREMENT_ID unset.
  await expect(page.locator("#consent-banner-mount")).toHaveCount(1);
  expect(await page.locator("#consent-banner-mount").innerHTML()).toBe("");
  await expect(page.locator(".consent-banner")).toHaveCount(0);
});
```

Check the About menu item id — `client/src/components/MenuBar.svelte` has `<button id="menuInfo" … onclick={() => act(() => window.MDE.openAbout())}>`. If `act()` closes the menu before the modal opens, the modal still mounts; the `a[href]` locators resolve once it's open. If the click needs the menu opened first, prefix with `await page.click("#helpMenuBtn")` (match the actual Help-menu trigger id — grep `helpMenu` in `MenuBar.svelte`).

- [ ] **Step 7: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
npx playwright test --project=local
npm run test:e2e:collab
```
Expected: all green.

- [ ] **Step 8: Manual check**

`npm run dev:client`, open `:5275`. Help → About → confirm Terms / Privacy open `/terms` `/privacy` in a new tab (they'll 404 through the client-only proxy — that's expected in `dev:client`; they work under `npm run dev`). No consent banner. Settings → no Analytics row (GA unset).

Then a one-off GA-on check: `VITE_GA_MEASUREMENT_ID=G-TEST npm run build && npm run dev`, open `:8787` — the consent banner appears; Accept → it's gone and stays gone on reload; Settings shows the Analytics row = On; Decline path likewise.

- [ ] **Step 9: Commit**

```bash
npm run format
git add client/src/components/Settings.svelte client/src/collab.ts client/src/gist.ts client/src/components/RepoLinkModal.svelte client/src/app.ts tests/client/src/components/Settings.test.ts tests/client/src/components/Settings.analytics.test.ts tests/e2e/local/legal-and-consent.spec.ts
git commit -m "$(cat <<'EOF'
feat(analytics): Settings toggle + content-free feature events

A Settings "Analytics" On/Off row (only when GA is configured). track()
calls for exported_doc, published_gist, linked_repo, shared_workspace;
setSignedIn from gist.ts's auth check. e2e: About links out, no banner
without a measurement id.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Release 1.57.0

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `CONTRIBUTING.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`
- Create: `client/public/whats-new/analytics-consent.png`, `tests/scripts/manual-testing/capture-analytics-consent-screenshot.mjs`

**Interfaces:** none.

**Context:**
- `package.json` `"version"` is `1.56.0`; `package-lock.json` has two `"version": "1.56.0"` lines (~3, ~9).
- `CHANGELOG.md` newest section is `## [1.56.0] - 2026-09-09`.
- `whats-new-entries.ts` `WHATS_NEW_ENTRIES` array, append at the end. `{version, title, description, screenshot, category}`, no date. `whats-new-entries.test.ts` requires the screenshot file to exist.
- The consent banner only renders with a GA id set, so the capture script must build with `VITE_GA_MEASUREMENT_ID=G-TEST`. Copy the flow from `tests/scripts/manual-testing/capture-topbar-chrome-v2-screenshot.mjs` (enable-dev-login not needed here — signed-out is fine).

- [ ] **Step 1: Version bump** — `package.json` + both `package-lock.json` lines → `1.57.0`. Verify with `grep`.

- [ ] **Step 2: CHANGELOG** — insert above `## [1.56.0] - 2026-09-09` (real current date):

```markdown
## [1.57.0] - <today>

### Added

- **Privacy-respecting analytics, off by default.** A one-time banner lets you opt in to anonymous, content-free usage analytics (which features get used, roughly how many visitors) — decline and nothing is collected. Change your mind any time in Settings. Documents, titles, and your GitHub username are never sent anywhere.
- **Full Privacy Policy and Terms of Service pages** at `/privacy` and `/terms`.

### Changed

- Terms of Service and Privacy Policy now open as proper pages in a new tab, instead of small in-app dialogs.
```

- [ ] **Step 3: What's New entry** — append:

```ts
  {
    version: "1.57.0",
    title: "Analytics, Opt-In Only",
    description:
      "The app now has a Privacy Policy and Terms of Service as full pages (at /privacy and /terms), and an optional, privacy-respecting analytics setup: a one-time banner asks before anything is collected, you can toggle it in Settings, and it never sees your document content, titles, or username.",
    screenshot: "/whats-new/analytics-consent.png",
    category: "Organization & Navigation",
  },
```

- [ ] **Step 4: Write the capture script**

`tests/scripts/manual-testing/capture-analytics-consent-screenshot.mjs`:

```js
// One-off: capture client/public/whats-new/analytics-consent.png — the
// consent banner. The banner only renders with a GA id set, so build with
// VITE_GA_MEASUREMENT_ID=G-TEST first:
//   VITE_GA_MEASUREMENT_ID=G-TEST npm run build
//   npm run dev &   # wait for :8787
//   node tests/scripts/manual-testing/capture-analytics-consent-screenshot.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:8787";
const OUT = "client/public/whats-new/analytics-consent.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
const gotIt = page.locator('button:has-text("Got it")');
if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
await page.locator(".consent-banner").waitFor({ timeout: 5000 });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);
await ctx.close();
await browser.close();
```

- [ ] **Step 5: Capture**

```bash
pkill -f "wrangler dev"; pkill -f "vite dev"
VITE_GA_MEASUREMENT_ID=G-TEST npm run build
npm run dev > /tmp/dev-ga.log 2>&1 &
# wait for curl -sf http://localhost:8787/
node tests/scripts/manual-testing/capture-analytics-consent-screenshot.mjs
pkill -f "wrangler dev"
```

Open `client/public/whats-new/analytics-consent.png` — confirm the banner with "Accept" / "Decline" / "Privacy Policy" is visible at the bottom. `client/dist/` is gitignored, so the temporary GA-id build never reaches the PR — no cleanup needed.

- [ ] **Step 6: Verify the screenshot test**

Run: `npx vitest run tests/client/src/whats-new-entries.test.ts`
Expected: PASS.

- [ ] **Step 7: CONTRIBUTING.md**

Add a short subsection (near the `.dev.vars` / OAuth notes):

```markdown
### Analytics (optional, production only)

Google Analytics loads **only** when `VITE_GA_MEASUREMENT_ID` (a GA4
`G-…` id) is set at build time. Leave it unset for local development,
tests, and self-hosting — the analytics module, consent banner, and
Settings row all no-op and nothing is sent. The maintainer's production
build sets it in Cloudflare's build environment.
```

- [ ] **Step 8: TEST-COVERAGE.md**

Add rows (App-shell section):

```markdown
| SHELL-30 | Legal pages — `src/worker.ts` serves `/privacy` and `/terms` (and trailing slash) from the `.html` assets before the SPA fallback; `client/public/privacy.html` + `terms.html` exist; the About modal links out to them in a new tab | integration + unit + e2e | covered | `tests/src/worker.test.ts`, `tests/client/src/about-links.test.ts`, `tests/e2e/local/legal-and-consent.spec.ts` | v1.57.0 |
| SHELL-31 | Analytics consent — `analyticsConsent` store: `initialConsent()` reads `mde:analyticsConsent`, forces `denied` under Do-Not-Track / Global Privacy Control, treats junk as `unset`; `setConsent` persists and survives a storage throw | unit | covered | `tests/client/src/stores/analyticsConsent.test.ts` | v1.57.0 |
| SHELL-32 | Analytics module — `analyticsAvailable` false + `initAnalytics` / `track` / `setSignedIn` all no-op (no `dataLayer`, no gtag script) when `VITE_GA_MEASUREMENT_ID` is unset (the test / self-host default); the event API is a closed enum with no payload | unit | covered | `tests/client/src/analytics.test.ts` | v1.57.0 |
| SHELL-33 | Consent banner — renders only when analytics is available AND consent is `unset`; Accept → `granted` + hidden, Decline → `denied` + hidden; never renders once decided or when analytics is unavailable. Settings "Analytics" On/Off row appears only when available and mirrors/sets the consent store | component + e2e | covered | `tests/client/src/components/ConsentBanner.test.ts`, `tests/client/src/components/Settings.analytics.test.ts`, `tests/e2e/local/legal-and-consent.spec.ts` | v1.57.0 |
```

- [ ] **Step 9: ROADMAP.md**

Add a new section under Active (after the topbar chrome section):

```markdown
### Analytics & legal (2026-09-09) — shipped v1.57.0

Spec `docs/superpowers/specs/2026-09-09-analytics-and-legal-pages-design.md`.
Standalone `/privacy` and `/terms` pages (the form Google OAuth
verification needs); opt-in GA4 behind Consent Mode v2, a consent
banner, and a Settings toggle — content-free events only, nothing loads
without a build-time `VITE_GA_MEASUREMENT_ID`.

**Next:** **Cloudflare Turnstile on anonymous workspace joins** — gate
not-signed-in "anyone with the link" joins (and possibly the
request-access POST) with a Turnstile challenge verified in the Worker.
Its own spec; note the impact on the collab e2e suite (Turnstile test
keys / bypass).
```

Also copy this spec's Non-goals into the "Deferred considerations" list (per `feedback_roadmap_deferred_considerations`): a Content-Security-Policy; a general cookie-consent banner; lawyer review of the legal text.

- [ ] **Step 10: Full verification**

```bash
npm test && npm run typecheck && npm run build && npm run format:check
npx playwright test --project=local
```
Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/analytics-consent.png tests/scripts/manual-testing/capture-analytics-consent-screenshot.mjs CONTRIBUTING.md docs/TEST-COVERAGE.md ROADMAP.md
git commit -m "$(cat <<'EOF'
chore: release 1.57.0 — analytics + standalone legal pages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12: Open the PR**

```bash
git push -u origin docs/analytics-legal-spec
gh pr create --title "Analytics + standalone legal pages — v1.57.0" --body "$(cat <<'EOF'
## What

**Legal pages** — full Privacy Policy and Terms of Service as self-contained HTML at `/privacy` and `/terms` (served by the Worker before the SPA fallback). The in-app `PrivacyModal` / `TermsModal` are deleted; About links out. These are the stable URLs Google's OAuth verification will point at when Drive sync ships.

**Analytics** — GA4 via `gtag.js`, **off by default**:
- Nothing loads unless `VITE_GA_MEASUREMENT_ID` is set at build (unset for dev / tests / self-host).
- Consent Mode v2, denied by default; a one-time banner (Accept / Decline + Privacy Policy link); a Settings On/Off toggle. Honors Do-Not-Track / Global Privacy Control.
- `track()` takes a closed event enum (`exported_doc`, `published_gist`, `linked_repo`, `shared_workspace`, `opened_command_palette`) — no free-form payload. The only user property is `signed_in: yes/no`. Document names, contents, and the GitHub username are never sent.

**Not in this PR:** Cloudflare Turnstile on anonymous joins — its own spec, next (noted in ROADMAP).

Spec: `docs/superpowers/specs/2026-09-09-analytics-and-legal-pages-design.md`
Plan: `docs/superpowers/plans/2026-09-09-analytics-and-legal-pages.md`

## Legal text

The Privacy Policy and Terms were drafted as a good-faith, accurate description of what the app does with data — not lawyer-reviewed. `drive.file` is a non-sensitive OAuth scope, so standard verification (privacy policy + domain verification + demo video) should suffice; no CASA assessment.

## Release

v1.57.0 — CHANGELOG (`### Added` + `### Changed`), What's New entry (with screenshot), CONTRIBUTING note, TEST-COVERAGE SHELL-30..33.

## Tests

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, `npx playwright test --project=local`, `npm run test:e2e:collab` all green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 13: Watch CI, merge on green** (after the user confirms).

---

## Self-Review

**1. Spec coverage:**
- A1 (privacy.html + terms.html content) → Task 1 Steps 5-6 (verbatim from the spec's content blocks). ✅
- A2 (worker `/privacy` `/terms` route + trailing slash + worker test) → Task 1 Steps 1-4. ✅
- A3 (delete modals, prune store, About links out, main.ts/index.html) → Task 2. ✅
- A4 (sitemap) → Task 2 Step 6. ✅
- B1 (Measurement ID via `import.meta.env`, `app_version`) → Task 4 (module) + Task 4 Step 1 (env type). ✅
- B2 (`analyticsConsent.ts`) → Task 3. ✅
- B3 (`analytics.ts` incl. `analyticsAvailable`) → Task 4. ✅
- B4 (`ConsentBanner.svelte` + scss + z-index 250 + reduced-motion + `/privacy` link) → Task 5. ✅
- B5 (Settings Analytics row, available-only) → Task 6 Steps 1-4. ✅
- B6 (main.ts init + mount + palette subscribe; `setSignedIn` in gist.ts; 4 `track` sites) → Task 5 Step 5 + Task 6 Step 5. ✅
- B7 (index.html mount only, no inline GA) → Task 5 Step 5. ✅
- Testing: consent unit (Task 3), analytics no-op unit (Task 4), banner component + unavailable (Task 5), Settings extend (Task 6), worker integration (Task 1), e2e (Task 6), screenshot (Task 7). ✅
- Release (version both lockfile fields, CHANGELOG Added+Changed, What's New + real screenshot + capture script, CONTRIBUTING, TEST-COVERAGE SHELL-30..33, ROADMAP + Turnstile-next + deferred-considerations) → Task 7. ✅
- Non-goal "no CSP", "no general cookie banner", "no lawyer review", "no Drive impl", "no custom pipeline", "no content/identity tracking" — all honored; the last is enforced by the enum-only `track` signature. ✅

**2. Placeholder scan:** No "TBD" / "handle edge cases" / "similar to Task N". `<today>` / `<date>` are fill-at-commit with an explicit "real current date". Task 1 Steps 5-6 reference "the spec's content block, verbatim" — that is reviewed canonical prose in the companion doc the executor reads alongside this plan (the header mandates it), not a placeholder. Line-number anchors in Task 6 are paired with a search string. The `addPerson` instrumentation ambiguity is resolved inline ("**Decision: instrument `setAccessMode` only.**").

**3. Type/name consistency:**
- `Consent` = `"granted" | "denied" | "unset"` — Task 3, consumed identically in Tasks 4/5/6.
- `analyticsConsent` / `setConsent` / `initialConsent` — Task 3 exports, used in Tasks 5/6.
- `analyticsAvailable` / `initAnalytics` / `track` / `setSignedIn` / `AnalyticsEvent` — Task 4 exports; `track` argument is the enum everywhere it's called (Task 5 `"opened_command_palette"`, Task 6 `"exported_doc"` / `"published_gist"` / `"linked_repo"` / `"shared_workspace"`).
- `mde:analyticsConsent` localStorage key — Task 3 impl + Task 3 test.
- `.consent-banner` class — Task 5 component + scss + all three banner tests.
- `#consent-banner-mount` — Task 5 (index.html + main.ts) + Task 6 e2e.
- `VITE_GA_MEASUREMENT_ID` — Task 4 env type + spec B1 + Task 7 capture script + CONTRIBUTING.
- Screenshot path `client/public/whats-new/analytics-consent.png` — Task 7 capture script + What's New entry + file list.
- `aboutModals.ts` post-prune exports (`aboutModalOpen`, `licensesModalOpen`) — Task 2 Step 4, consumed by `AboutModal.svelte` (Step 3) and `LicensesModal.svelte` (untouched).

No gaps found.
