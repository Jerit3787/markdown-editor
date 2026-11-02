# Dedicated Marketing Homepage (`/home`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a fast, static marketing homepage at `/home` (`https://editor.danplace.tech/home`) that satisfies all Google Trust & Safety OAuth verification requirements (app branding, purpose description, public access, no login wall, and prominent legal links).

**Architecture:** A static HTML document at `client/public/home.html` (served at `/home` by Cloudflare Worker with nonced CSP header); links to `/home` integrated into the editor's Help menu, empty-state landing card, and legal page headers; `docs/GOOGLE-OAUTH-VERIFICATION.md` updated with the `/home` URL.

**Tech Stack:** Semantic HTML5, CSS custom properties, Cloudflare Worker (`src/worker.ts`, `src/csp.ts`), Svelte 5 (`MenuBar.svelte`, `AboutModal.svelte`, `CommandPalette.svelte`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-11-dedicated-homepage-design.md`

## Global Constraints

- Production domain: `https://editor.danplace.tech`.
- Exact App Name: `Markdown Editor` (must match Google Cloud Console OAuth consent screen).
- Scope mentioned: `https://www.googleapis.com/auth/drive.file`.
- Support email: `support@danplace.tech`.
- Zero external client runtime dependencies for `client/public/home.html` — self-contained styles and inline SVGs to ensure instant loading for crawlers and bots.
- `npm run format` (Prettier) + `npm run typecheck` pass before every commit.
- Commit trailer strictly: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `client/public/home.html` (new) | Standalone marketing landing page | 1 |
| `client/public/sitemap.xml` | Add `/home` entry to XML sitemap | 1 |
| `src/worker.ts` | Pass `/home` to asset layer with strict content CSP | 2 |
| `tests/src/worker.test.ts` | Unit test for `/home` route and CSP header | 2 |
| `client/index.html` | Add `icon-home` SVG symbol; add `/home` to empty-state footer | 3 |
| `client/src/components/MenuBar.svelte` | Add `Homepage & Features` link to Help menu | 3 |
| `client/src/components/AboutModal.svelte` | Add `Homepage & Features` link to About dialog | 3 |
| `client/src/components/CommandPalette.svelte` | Add `Homepage & Features` command | 3 |
| `legal/privacy.html`, `legal/terms.html` | Add `Home` link to top navigation bar | 3 |
| `docs/GOOGLE-OAUTH-VERIFICATION.md` | Update Application home page instructions to `/home` | 4 |
| `tests/e2e/local/homepage.spec.ts` (new) | Playwright E2E spec verifying `/home` rendering and links | 5 |

---

## Task 1: Create `client/public/home.html` & Update Sitemap

**Files:**
- Create: `client/public/home.html`
- Modify: `client/public/sitemap.xml`

- [ ] **Step 1: Write `client/public/home.html`**
  - Include `<title>Markdown Editor — The Fast, Private Markdown Workspace</title>`.
  - Include Meta tags (description, Open Graph, Twitter cards, viewport).
  - Include responsive stylesheet using CSS variables matching the app's clean dark/light themes.
  - Include Sticky Header with logo (`/logo.svg`), `Markdown Editor` brand title, nav links (`#features`, `#google-drive`, `/privacy`, `/terms`), and "Launch Editor" button (`href="/"`).
  - Include Hero Section:
    - Badge: `Free & Open Source • 100% In-Browser`.
    - Main heading: `<h1>Markdown Editor</h1>`.
    - Subheading: `The Fast, Private, In-Browser Markdown Workspace`.
    - Descriptive paragraph detailing core value proposition.
    - Buttons: `Launch Editor — It's Free` (`/`) and `View on GitHub`.
    - Visual Mockup: CSS-rendered split-pane editor preview showing markdown on the left (with headings, KaTeX math `\int_0^\infty e^{-x^2} dx`, and Mermaid code) and formatted preview on the right.
  - Include Core Features Grid (`#features`):
    - 6 feature cards: Live Preview, In-Browser Privacy, Google Drive Integration, GitHub & Gist Sync, Real-time Collaboration, Flexible Export.
  - Include Google Drive & Data Safety Section (`#google-drive`):
    - Detailed `drive.file` scope justification.
    - AES-256-GCM token storage in HttpOnly cookies.
    - Zero server-side document storage; local-only processing.
    - No-AI & no-sale guarantees.
    - Links to `/privacy` and `/terms`.
  - Include FAQ Section answering common questions (accounts, storage, cost).
  - Include Footer with links to `/privacy`, `/terms`, GitHub repository, and `support@danplace.tech`.

- [ ] **Step 2: Update `client/public/sitemap.xml`**
  - Add `<url><loc>https://editor.danplace.tech/home</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`.

- [ ] **Step 3: Test local build & format**
  - Run `npm run format`.
  - Run `npm run build`.
  - Verify `client/dist/home.html` is generated.

- [ ] **Step 4: Commit Task 1**
  - Commit message: `feat(homepage): create static marketing homepage client/public/home.html`

---

## Task 2: Configure Worker Routing & CSP for `/home`

**Files:**
- Modify: `src/worker.ts`
- Modify: `tests/src/worker.test.ts`

- [ ] **Step 1: Write failing test in `tests/src/worker.test.ts`**
  - Add `"/home"` to the array of static content paths tested for unchanged forwarding and strict CSP header.
  - Run `npm test tests/src/worker.test.ts` and verify it fails if `/home` is not recognized as a static doc.

- [ ] **Step 2: Update `src/worker.ts`**
  - Update `isLegalPage` (rename to `isStaticDoc` or include `url.pathname === "/home"`):
    ```typescript
    const isStaticDoc = url.pathname === "/privacy" || url.pathname === "/terms" || url.pathname === "/home";
    const policy = isStaticDoc ? legalCsp(nonce) : appCsp(nonce);
    ```
  - Ensure `/home` is forwarded to `env.ASSETS.fetch(request)` with unchanged URL and transformed with nonce and strict CSP.

- [ ] **Step 3: Run unit tests**
  - Run `npm test tests/src/worker.test.ts` to verify all tests pass.
  - Run `npm test tests/src/csp.test.ts`.

- [ ] **Step 4: Commit Task 2**
  - Commit message: `feat(worker): route /home with strict content CSP`

---

## Task 3: In-App Links to Homepage

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/components/MenuBar.svelte`
- Modify: `client/src/components/AboutModal.svelte`
- Modify: `client/src/components/CommandPalette.svelte`
- Modify: `legal/privacy.html`
- Modify: `legal/terms.html`

- [ ] **Step 1: Add `icon-home` to `client/index.html`**
  - Add `<symbol id="icon-home" viewBox="0 0 24 24">` to the SVG sprite in `client/index.html`.
  - Add `<a href="/home">Homepage</a>` in both `.empty-state-footer` elements.

- [ ] **Step 2: Add Homepage link to `MenuBar.svelte`**
  - Add a menu link item under the `Help` menu:
    ```svelte
    <a class="menu-link-item" href="/home">
      <svg class="icon"><use href="#icon-home"></use></svg> Homepage &amp; Features
    </a>
    ```

- [ ] **Step 3: Add Homepage link to `AboutModal.svelte`**
  - Add `<a class="menu-link-item" href="/home" target="_blank" rel="noopener"><svg class="icon"><use href="#icon-home"></use></svg> Homepage &amp; Features</a>` above Terms & Privacy in `.about-links`.

- [ ] **Step 4: Add Homepage command to `CommandPalette.svelte`**
  - Add `{ id: "homepage", label: "Homepage & Features", category: "Help", run: () => window.location.href = "/home" }`.

- [ ] **Step 5: Add Home link to `legal/privacy.html` and `legal/terms.html`**
  - Update top header nav to include `Home` (`<a href="/home">Home</a>`) alongside `Back to Editor`.
  - Run `npm run generate:legal` to update `client/public/{privacy,terms}.html`.

- [ ] **Step 6: Verify formatting and types**
  - Run `npm run format`.
  - Run `npm run typecheck`.
  - Run `npm test`.

- [ ] **Step 7: Commit Task 3**
  - Commit message: `feat(ui): add in-app links to homepage in menubar, about modal, and empty state`

---

## Task 4: Update Google OAuth Verification Handbook

**Files:**
- Modify: `docs/GOOGLE-OAUTH-VERIFICATION.md`

- [ ] **Step 1: Update documentation with `/home`**
  - Update Section 1 with the new homepage resolution.
  - Update Section 2: Set **Application home page** to `https://editor.danplace.tech/home`.
  - Update pre-submission checklist to verify `https://editor.danplace.tech/home` is reachable and displays the required elements.

- [ ] **Step 2: Commit Task 4**
  - Commit message: `docs(oauth): update verification handbook with /home application homepage`

---

## Task 5: End-to-End Testing & Final Verification

**Files:**
- Create: `tests/e2e/local/homepage.spec.ts`

- [ ] **Step 1: Write E2E test `tests/e2e/local/homepage.spec.ts`**
  - Test that `/home` returns 200 OK.
  - Test that `h1` contains "Markdown Editor".
  - Test that the primary "Launch Editor" button has `href="/"`.
  - Test that Privacy Policy and Terms of Service links point to `/privacy` and `/terms`.
  - Test that feature cards and Google Drive section are visible.
  - Test that page renders cleanly at both desktop (1280px) and mobile (390px) viewports.

- [ ] **Step 2: Run all tests**
  - Run `npx playwright test tests/e2e/local/homepage.spec.ts`.
  - Run `npm test`.
  - Run `npm run typecheck`.
  - Run `npm run format:check`.

- [ ] **Step 3: Commit Task 5**
  - Commit message: `test(e2e): add homepage test suite for /home`
