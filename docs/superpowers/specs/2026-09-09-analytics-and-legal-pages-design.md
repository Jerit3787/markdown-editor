# Analytics + standalone legal pages — design

**Status:** approved (brainstorm 2026-09-09)
**Ships as:** one user-facing minor release (`1.57.0`).

## Goal

Two coupled pieces:

- **Part A — Legal pages.** Move the Terms of Service and Privacy Policy
  out of in-app modals into standalone HTML documents served at stable
  URLs (`/terms`, `/privacy`) — the form Google's OAuth verification
  needs for the future Google Drive integration. Write proper content:
  everything the app does with data today, the new analytics, and a
  "not yet available" section for Google Drive.
- **Part B — Google Analytics.** Add GA4 (`gtag.js`) behind Consent Mode
  v2 and a small consent banner. Page views + a handful of payload-free
  feature events + a coarse `signed_in` (yes/no) user property. Nothing
  loads unless a build-time Measurement ID is set, and nothing
  non-essential fires until the visitor accepts.

Part A lands first (the consent banner links to `/privacy`).

## Non-goals / deferred

- **CAPTCHA / Cloudflare Turnstile.** Gating anonymous "anyone with the
  link" workspace joins is worthwhile but is its own spec (its own
  endpoints decision, its own impact on the collab e2e suite). Added to
  `ROADMAP.md` as the next item.
- **A Content-Security-Policy.** The app has none today; adding GA
  doesn't force one (no CSP to violate). A CSP is a separate hardening
  task.
- **A general cookie-consent banner.** The banner here is
  analytics-only. The app sets one functional cookie (the GitHub session)
  which is strictly necessary and needs no consent.
- **Legal review by a lawyer.** The drafted text is a good-faith,
  accurate description of real data handling. `drive.file` is a
  non-sensitive OAuth scope, so standard verification (privacy policy +
  domain verification + a demo video) should suffice — no CASA
  assessment. Note this in the PR.
- **Implementing Google Drive sync.** Only the privacy-policy section is
  written now; the feature stays on its own branch (`feat/google-drive-sync`).
- **Server-side analytics / a custom events pipeline.** GA4 only.
- **Tracking document content, titles, or user identity.** Explicitly
  forbidden — events carry no payload; the only user property is a
  boolean.

## Global constraints

- Two `tsconfig.json`s, checked separately. New client code under
  `client/src/`.
- Svelte 5 runes. Component tests → `tests/client/src/components/*.test.ts`
  (`components` project, real headless Chromium).
- `npm run format` (Prettier) + `npm run typecheck` must pass.
- Production domain: `https://editor.danplace.tech`.
- GA loads **only** when `import.meta.env.VITE_GA_MEASUREMENT_ID` is a
  non-empty `G-…` string at build time. Unset in dev, tests, CI, and
  self-host → zero GA code paths execute, no network, no cookies.
- No CSP exists; `googletagmanager.com` / `google-analytics.com` load
  without allowlisting.
- User-facing → **minor** bump to `1.57.0`: `package.json` + both
  `package-lock.json` `"version"` fields; `## [1.57.0] - <date>`
  CHANGELOG (`### Added` + `### Changed`); one `whats-new-entries.ts`
  entry with a real committed screenshot at
  `client/public/whats-new/analytics-consent.png`; `docs/TEST-COVERAGE.md`
  updated.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

# Part A — Legal pages

## A1. The documents

Two self-contained files under `client/public/` — plain HTML, one inline
`<style>` block, no external assets, readable without the app's JS. They
share a small stylesheet (system font stack, max-width ~720px, generous
line-height, the app's blue `#2563eb` for links and the `Md` wordmark up
top linking back to `/`). A "Last updated: 2026-09-09" line under each
title.

### `client/public/privacy.html` — content

> **Privacy Policy**
> Last updated: 2026-09-09
>
> Markdown Editor ("the app", at `editor.danplace.tech`) is a free,
> open-source markdown editor. This policy explains what happens to your
> data when you use it. The app is operated by the project's maintainer
> as a personal project; there is no company behind it.
>
> **1. Your documents stay on your device.**
> Documents, workspaces, version history, and personal notes are stored
> in your browser's `localStorage`, on your device only. They are never
> sent to or stored on the app's servers unless you take one of the
> explicit actions in sections 3–5. Clearing your browser storage
> deletes them permanently; nothing is backed up for you.
>
> **2. Signing in with GitHub.**
> Connecting a GitHub account (optional; needed only for Publish to Gist,
> repo sync, and being identified in a shared workspace) runs GitHub's
> standard OAuth flow. GitHub returns an access token to the app's
> server, which encrypts it into an `HttpOnly` cookie stored by your
> browser. That cookie is never readable by this page's JavaScript and
> is used only to call GitHub's API on your behalf (create/read Gists,
> read/write the repos you choose, read your username and avatar).
> Signing out (or the token being revoked) clears it. We store no GitHub
> data on our servers.
>
> **3. Sharing a workspace / real-time collaboration.**
> When you share a workspace, its documents' live contents, plus comment
> threads, version snapshots, and the access list, are held in a
> Cloudflare Durable Object for as long as that shared workspace exists,
> so collaborators can sync. Who can read it is governed by the access
> settings you choose (specific GitHub users, or anyone with the link).
> Deleting the shared workspace deletes that server-side copy. If you
> never share, nothing here applies.
>
> **4. Publishing to a GitHub Gist or syncing to a repository.**
> These actions send the document content (and pasted images) to GitHub
> under your account, at your request. From that point GitHub's terms and
> privacy policy govern that copy.
>
> **5. Analytics.**
> The app uses Google Analytics 4 to understand which features are used
> and roughly how many people visit — **only if you accept** via the
> consent banner shown on your first visit. If you decline (or your
> browser sends a "Do Not Track" / Global Privacy Control signal), no
> analytics cookies are set and no analytics data is collected beyond an
> anonymous, cookieless ping that records the decline.
> When enabled, Google Analytics collects: pages viewed, approximate
> location (country/region, from your IP — which Google does not store),
> device and browser type, and a random client identifier stored in a
> cookie. The app additionally sends a small number of **feature events
> with no content** — for example that a workspace was shared or a
> document exported — and a single yes/no property for whether a GitHub
> account is connected. **The app never sends Google your document
> names, your document contents, your GitHub username, or any other
> identifying information.** You can change your choice any time under
> Settings → Analytics. Google's handling of the data it receives is
> covered by [Google's Privacy Policy](https://policies.google.com/privacy).
>
> **6. Google Drive — not yet available.**
> A Google Drive integration is planned but **not currently part of the
> app**. When it ships, it will request only the `drive.file` scope,
> which limits the app to files you specifically open or create with it —
> it cannot see the rest of your Drive. Files you open or save through
> that feature would be read from and written to your Drive at your
> request only. Google user data obtained this way will never be sold,
> never used for advertising, and never used to train AI models. This
> section will be finalised before the feature is released.
>
> **7. Hosting.**
> The app is hosted on Cloudflare. Cloudflare processes each request to
> deliver the app and keeps standard, short-lived server logs (IP
> address, timestamp, requested URL, user agent) to operate and protect
> the service — the same as any web host. See Cloudflare's privacy
> documentation for details.
>
> **8. Data retention and deletion.**
> Local documents: until you clear them. The GitHub session cookie:
> until you sign out or it expires. A shared workspace's server copy:
> until you delete that workspace. Analytics: per Google Analytics'
> configured retention (set to the minimum, 2 months, for event data).
> To delete everything the app holds for you: sign out, delete any
> shared workspaces you own, and clear the site's browser storage.
>
> **9. Children.**
> The app is not directed at children under 13 and does not knowingly
> collect their data.
>
> **10. Changes.**
> Material changes to this policy will be reflected here with a new
> "Last updated" date. Continued use after a change means you accept it.
>
> **11. Contact.**
> Open an issue at
> [github.com/Jerit3787/markdown-editor](https://github.com/Jerit3787/markdown-editor/issues).

### `client/public/terms.html` — content

> **Terms of Service**
> Last updated: 2026-09-09
>
> **1. The service.**
> Markdown Editor is a free, open-source tool provided as-is by the
> project's maintainer as a personal project, with no warranty of any
> kind, express or implied. You use it at your own risk.
>
> **2. No warranty; limitation of liability.**
> The app may change, break, lose data, be interrupted, or be shut down
> at any time without notice. To the maximum extent permitted by law,
> the maintainer is not liable for any loss or damage arising from your
> use of the app, including lost documents. Documents you have not shared
> live only in your browser — keep your own backups.
>
> **3. Acceptable use.**
> Don't use the app to store, share, or transmit content you don't have
> the right to, or anything unlawful, harmful, or abusive. Don't try to
> break, overload, probe, or gain unauthorised access to the service or
> other users' data. Don't use the sharing or collaboration features to
> distribute malware or run automated abuse. The maintainer may block
> access or remove shared content that violates this section.
>
> **4. Your content.**
> You keep all rights to your documents. By sharing a workspace you grant
> the people you share it with, and the service (only to operate the
> sharing feature), the ability to store and display that content. That
> permission ends when you delete the shared workspace.
>
> **5. Third-party services.**
> Signing in with GitHub, publishing to a Gist, or syncing a repository
> means GitHub's terms and privacy policy also apply to those actions.
> Analytics is provided by Google under Google's terms.
>
> **6. Open source.**
> The app is open source. You may read, modify, and self-host it under
> the licence in the repository. These terms apply to the maintainer's
> hosted instance at `editor.danplace.tech`, not to your own copy.
>
> **7. Changes to these terms.**
> Updated terms will be posted here with a new "Last updated" date.
>
> **8. Contact.**
> [github.com/Jerit3787/markdown-editor](https://github.com/Jerit3787/markdown-editor/issues).

> **Implementation note:** the repo's public GitHub URL uses the owner
> `Jerit3787` (see `AboutModal.svelte`'s existing link). Match that
> exactly in both documents.

## A2. Serving them at `/privacy` and `/terms`

`src/worker.ts` — before the `return env.ASSETS.fetch(request)` fallthrough,
add:

```ts
const LEGAL_PAGE = /^\/(privacy|terms)\/?$/;
const legalMatch = url.pathname.match(LEGAL_PAGE);
if (legalMatch) {
  const assetUrl = new URL(`/${legalMatch[1]}.html`, url);
  return env.ASSETS.fetch(new Request(assetUrl, request));
}
```

Placed near the other top-level `if (url.pathname === …)` checks. This
runs before the SPA fallback, so `/privacy` serves the real document,
not `index.html`. A worker test asserts `/privacy` and `/terms` return
200 with `content-type: text/html` and the document's `<h1>` text.

## A3. Remove the modals, link out

- **Delete** `client/src/components/PrivacyModal.svelte` and
  `client/src/components/TermsModal.svelte`.
- **Delete** `client/src/main.ts`'s imports + `mount()` calls for them.
- **Delete** `client/index.html`'s `<div id="terms-modal-mount">` and
  `<div id="privacy-modal-mount">` (and fix the nearby comment).
- **`client/src/stores/aboutModals.ts`** — remove `termsModalOpen` and
  `privacyModalOpen` exports.
- **`client/src/components/AboutModal.svelte`** — replace the two
  `<button onclick={openTerms/openPrivacy}>` with:
  ```svelte
  <a class="menu-link-item" href="/terms" target="_blank" rel="noopener">
    <svg class="icon"><use href="#icon-file"></use></svg> Terms of Service
  </a>
  <a class="menu-link-item" href="/privacy" target="_blank" rel="noopener">
    <svg class="icon"><use href="#icon-lock"></use></svg> Privacy Policy
  </a>
  ```
  Delete `openTerms` / `openPrivacy` and the now-unused imports.
- Grep the repo for any other `privacyModalOpen` / `termsModalOpen` /
  "Privacy Policy" references (menu bar, footer, consent banner) and
  point them at the URLs.

## A4. `client/public/sitemap.xml`

Add `<url>` entries for `https://editor.danplace.tech/privacy` and
`…/terms` (`changefreq: yearly`, `priority: 0.3`).

---

# Part B — Google Analytics

## B1. Config

- **Measurement ID:** `import.meta.env.VITE_GA_MEASUREMENT_ID`. Vite
  exposes any `VITE_`-prefixed env var on `import.meta.env` with no
  `define` entry needed. Document in `CONTRIBUTING.md` that production
  builds set it in Cloudflare's build environment; everything else
  leaves it unset.
- **`app_version`:** pass `__APP_VERSION__` as a GA config param so
  releases are distinguishable.

## B2. `client/src/stores/analyticsConsent.ts` (new)

```ts
import { writable } from "svelte/store";

export type Consent = "granted" | "denied" | "unset";
const KEY = "mde:analyticsConsent";

// Do-Not-Track / Global Privacy Control → treat as an explicit decline,
// no banner.
function browserOptOut(): boolean {
  try {
    return (
      navigator.doNotTrack === "1" ||
      (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true
    );
  } catch {
    return false;
  }
}

export function initialConsent(): Consent {
  if (browserOptOut()) return "denied";
  try {
    const v = localStorage.getItem(KEY);
    return v === "granted" || v === "denied" ? v : "unset";
  } catch {
    return "unset";
  }
}

export const analyticsConsent = writable<Consent>(initialConsent());

export function setConsent(next: "granted" | "denied"): void {
  analyticsConsent.set(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode — the in-memory store still drives this session */
  }
}
```

`browserOptOut` and `initialConsent` are the unit-tested core.

## B3. `client/src/analytics.ts` (new)

```ts
import { get } from "svelte/store";
import { analyticsConsent, type Consent } from "./stores/analyticsConsent";

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

// The banner and the Settings row key off this — nothing analytics-shaped
// renders when GA isn't configured for this build.
export const analyticsAvailable = !!GA_ID;

type GtagArgs = [string, ...unknown[]];
function gtag(...args: GtagArgs): void {
  (window as unknown as { dataLayer?: unknown[] }).dataLayer?.push(args);
}

let scriptLoaded = false;

function loadGaScript(): void {
  if (scriptLoaded || !GA_ID) return;
  scriptLoaded = true;
  (window as unknown as { dataLayer: unknown[] }).dataLayer ??= [];
  gtag("js", new Date());
  gtag("config", GA_ID, { anonymize_ip: true, app_version: __APP_VERSION__ });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);
}

function applyConsent(c: Consent): void {
  if (!GA_ID) return;
  (window as unknown as { dataLayer: unknown[] }).dataLayer ??= [];
  gtag("consent", "update", {
    analytics_storage: c === "granted" ? "granted" : "denied",
  });
  if (c === "granted") loadGaScript();
}

// Call once at startup. Sets Consent Mode's denied-by-default baseline,
// then reacts to the stored/updated choice.
export function initAnalytics(): void {
  if (!GA_ID) return;
  (window as unknown as { dataLayer: unknown[] }).dataLayer ??= [];
  gtag("consent", "default", {
    analytics_storage: "denied",
    wait_for_update: 500,
  });
  analyticsConsent.subscribe(applyConsent); // fires immediately with current value
}

export type AnalyticsEvent =
  | "shared_workspace"
  | "published_gist"
  | "linked_repo"
  | "exported_doc"
  | "opened_command_palette";

// No-ops unless GA is configured AND consent is granted. Never accepts
// or forwards a payload with identifying content.
export function track(event: AnalyticsEvent): void {
  if (!GA_ID || get(analyticsConsent) !== "granted") return;
  gtag("event", event);
}

export function setSignedIn(signedIn: boolean): void {
  if (!GA_ID || get(analyticsConsent) !== "granted") return;
  gtag("set", "user_properties", { signed_in: signedIn ? "yes" : "no" });
}
```

`track` / `setSignedIn` deliberately take no free-form params — the
enum is the whole API surface, so nothing identifying can be passed.

## B4. `client/src/components/ConsentBanner.svelte` (new)

- Renders only when `$analyticsConsent === "unset"` **and** `GA_ID` is
  set (import the same `GA_ID` check, or a small exported
  `analyticsAvailable` boolean from `analytics.ts`).
- A fixed bar at the bottom (above `.toast-stack`'s `z-index: 200` → use
  `z-index: 250`), full width on mobile, a centered max-width card on
  desktop. Text: *"We use privacy-respecting analytics to see which
  features get used. No document content is ever collected."* +
  **Accept** / **Decline** buttons + a "Privacy Policy" link
  (`href="/privacy" target="_blank"`).
- Accept → `setConsent("granted")`; Decline → `setConsent("denied")`.
  Either dismisses the banner (the `{#if}` flips).
- Respects `prefers-reduced-motion` for its slide-in.
- New `_consent-banner.scss` partial, registered in `client/src/style.scss`.

## B5. `client/src/components/Settings.svelte` — Analytics row

After the GitHub row, a new `.setting-row`:

- Label "Analytics", desc "Help improve the app by sharing anonymous,
  content-free usage data."
- A `.tab-switch` (matching the Theme / Keybindings pattern) with
  **On** / **Off**, bound to `$analyticsConsent` (`"granted"` = On,
  anything else = Off). Changing it calls `setConsent(...)`.
- Only shown when analytics is available (`GA_ID` set) — otherwise the
  row is hidden (self-host / dev never see a dead toggle).
- If the browser opted out (DNT/GPC), the row shows the toggle forced
  Off + disabled, with a note "Disabled by your browser's privacy
  setting."

## B6. Wiring

- **`client/src/main.ts`** — `import { initAnalytics } from "./analytics"`,
  call `initAnalytics()` early (after stores import, before/around the
  component mounts); `mount(ConsentBanner, …)` on a new
  `<div id="consent-banner-mount">` in `client/index.html`.
- **`setSignedIn`** — call from wherever `githubUsername` is first known
  and on change. `gist.ts` already owns that (`githubUsernameStore.set`
  in its `render()`); add `setSignedIn(!!connectedUsername)` right after.
- **`track` calls** — one line each:
  - `collab.ts` — after a successful workspace share (the point where
    `generalAccess` becomes `"anyone"` or an invite is added, or simplest:
    in the share-success path in `Share.svelte` / `openShareModal`'s
    confirm). Pick the single clearest spot; `"shared_workspace"`.
  - `gist.ts` — after a successful Gist create → `"published_gist"`.
  - `repo-sync.ts` (or `repo-sync-ui.ts`) — after a repo is first linked
    → `"linked_repo"`.
  - `app.ts` — in the export handler (any format) → `"exported_doc"`;
    in the command-palette open path → `"opened_command_palette"`.
  Each is fire-and-forget; `track` already no-ops when unconfigured.

## B7. `client/index.html`

No inline GA snippet. Just the mount point:
`<div id="consent-banner-mount"></div>` near the other mounts. All GA
bootstrapping is in `analytics.ts` so tests and self-host builds carry
none of it.

---

## Testing

### Unit — `tests/client/src/stores/analyticsConsent.test.ts`
- `initialConsent()`: no stored value → `"unset"`; stored `"granted"` /
  `"denied"` → that; stored garbage → `"unset"`; `navigator.doNotTrack
  === "1"` → `"denied"` regardless of storage;
  `navigator.globalPrivacyControl === true` → `"denied"`.
- `setConsent("granted")` → store is `"granted"` and `localStorage`
  holds `"granted"`; survives a `localStorage` throw (store still set).

### Unit — `tests/client/src/analytics.test.ts`
- With `VITE_GA_MEASUREMENT_ID` unset (the default in tests):
  `initAnalytics()`, `track("exported_doc")`, `setSignedIn(true)` all
  no-op — `window.dataLayer` is never created, no script tag added.
- (Testing the configured path requires stubbing `import.meta.env`; if
  that's awkward under Vitest, assert the unconfigured no-op contract
  only and cover the configured path via the component test's mock.)

### Component — `tests/client/src/components/ConsentBanner.test.ts`
- `analyticsConsent` `"unset"` + analytics available (mock the
  `analyticsAvailable` export) → the banner renders with Accept /
  Decline and a `/privacy` link.
- Click Accept → `get(analyticsConsent) === "granted"`, banner gone.
- Click Decline → `"denied"`, banner gone.
- `analyticsConsent` `"granted"` at mount → banner never renders.
- analytics unavailable → banner never renders even when `"unset"`.

### Component — `tests/client/src/components/Settings.test.ts` (extend)
- Analytics row hidden when analytics unavailable; visible + reflects
  `analyticsConsent` when available (mock); toggling calls `setConsent`.

### Integration — `tests/src/worker.test.ts` (extend)
- `GET /privacy` → 200, `text/html`, body contains `Privacy Policy`.
- `GET /terms` → 200, `text/html`, body contains `Terms of Service`.
- `GET /privacy/` (trailing slash) → 200.

### e2e — `tests/e2e/local/legal-and-consent.spec.ts` (new)
- `/privacy` and `/terms` load and show their headings (served by the
  worker; in the `local` client-only suite these 404 through the vite
  proxy — so instead assert the **files exist** via a unit check, and
  put the URL check in the worker integration test above). The e2e here
  covers: About modal → "Privacy Policy" link has `href="/privacy"`.
- The consent banner does **not** appear in the local suite (no
  `VITE_GA_MEASUREMENT_ID`) — assert `#consent-banner-mount` is empty.

### Screenshot
`client/public/whats-new/analytics-consent.png` — capture the consent
banner. Since the local/dev build has no GA ID, the capture script sets
`VITE_GA_MEASUREMENT_ID=G-TEST` for a one-off `vite build` (or stubs
`analyticsAvailable`), loads the page, screenshots the banner.

---

## Release

- `package.json` + `package-lock.json` → `1.57.0`.
- `CHANGELOG.md` `## [1.57.0] - <date>`:
  - `### Added` — Privacy-respecting analytics with an opt-in banner and
    a Settings toggle; standalone Privacy Policy and Terms of Service
    pages.
  - `### Changed` — Terms / Privacy now open as full pages instead of
    small in-app dialogs.
- `client/src/whats-new-entries.ts` — a `1.57.0` entry
  (`category: "Organization & Navigation"`), screenshot
  `/whats-new/analytics-consent.png`.
- `CONTRIBUTING.md` — a note on `VITE_GA_MEASUREMENT_ID` (unset for dev /
  self-host; set in Cloudflare's build env for production).
- `docs/TEST-COVERAGE.md` — rows for the consent logic, the banner, the
  legal-page routes, and the analytics no-op contract.
- `ROADMAP.md` — mark this shipped under a new "Analytics & legal"
  heading; add **"Cloudflare Turnstile on anonymous workspace joins"**
  as the next planned item (its own spec).

## Implementation order (one commit each, TDD)

1. **A1+A2** — `privacy.html` + `terms.html` + the worker `/privacy`
   `/terms` routes + worker integration tests.
2. **A3+A4** — delete the modals, rewire `AboutModal` to links, prune
   `aboutModals.ts` / `main.ts` / `index.html`, update `sitemap.xml`;
   the e2e link assertion.
3. **B2** — `analyticsConsent.ts` store + unit tests.
4. **B3** — `analytics.ts` (`initAnalytics` / `track` / `setSignedIn`) +
   the unconfigured-no-op unit test.
5. **B4** — `ConsentBanner.svelte` + `_consent-banner.scss` + mount +
   `initAnalytics()` wiring in `main.ts` + component tests.
6. **B5+B6** — Settings Analytics row + `setSignedIn` / `track` call
   sites + Settings test extension.
7. **Release** — version, CHANGELOG, What's New + screenshot,
   CONTRIBUTING, TEST-COVERAGE, ROADMAP.
