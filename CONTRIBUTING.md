# Contributing

Thanks for considering a contribution. This project follows the
[Code of Conduct](CODE_OF_CONDUCT.md) — please read it before
participating.

## Run locally

```
npm install
npm run build
npm run dev
```

`npm run dev` runs `wrangler dev`, which serves whatever's currently in
`client/dist` alongside the collaboration/auth/Gist Worker, matching
production — it does **not** rebuild the client on its own, so re-run
`npm run build` after client-side changes (or run
`vite build --config client/vite.config.ts --watch` in a second
terminal). GitHub sign-in and Gist publishing need a real OAuth App (see
below); everything else (editing, local multi-doc, export, sharing
between two tabs on the same machine) works without one.

For fast client-only iteration without the Worker (no
collaboration/auth/Gist endpoints), `npm run dev:client` runs a plain
Vite dev server instead.

## Tests and checks

```
npm test                  # Vitest — unit tests + Svelte component tests, one command
npm run typecheck         # tsc --noEmit (root/server) + svelte-check (client)
npm run format:check      # Prettier
npm run check:no-dev-login # fails if the manual-testing /api/dev/login route is committed
npm run test:e2e:local    # Playwright (Chromium), client-only flows
npm run test:e2e:webkit   # Playwright (WebKit, iPhone viewport), mobile-Safari-width checks
npm run test:e2e:collab   # Playwright, spins up a real Worker + live collaboration
```

The Playwright browsers download on first run — `npx playwright install
chromium webkit` if you want them ahead of time.

`npm test` and `npm run typecheck` are fast enough to run on every
change; the Playwright suites are heavier (`test:e2e:collab` needs a
real `wrangler dev` instance) and mainly matter for collaboration/
sharing changes. All of the above (plus `npm run build`) run in CI on
every PR.

## GitHub OAuth App (optional, for sign-in/Gist/Share)

Create an OAuth App at GitHub → Settings → Developer settings → OAuth
Apps, with callback URL `http://127.0.0.1:8787/api/auth/github/callback`
for local dev. Then:

- `GITHUB_CLIENT_ID` is a plain (non-secret) var, already set in
  `wrangler.jsonc`
- `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` (any random string, used
  to encrypt the session cookie) are Worker secrets — for local dev put
  them in a git-ignored `.dev.vars` file:
  ```
  GITHUB_CLIENT_SECRET=...
  SESSION_SECRET=...
  ```

Setting these up for a production deployment is covered separately in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Google OAuth (optional, for Google Drive)

Drive integration (open markdown from Drive, and later save + folder sync)
needs a Google Cloud project. Without it the Google menu items are hidden
and everything else works — same as GitHub OAuth above.

1. [Google Cloud Console](https://console.cloud.google.com/) → new project
   → **enable the Google Drive API and the Google Picker API**.
2. OAuth consent screen → External → fill the app name / emails → add the
   `.../auth/drive.file` scope → add your Google account as a **test
   user** (keeps the app in "testing" mode; the consent screen just warns
   "unverified" — fine for local dev).
3. Credentials → **OAuth client ID** → Web application → Authorized
   redirect URIs: `http://localhost:8787/api/auth/google/callback`.
4. Credentials → **API key** (for the Picker); optionally restrict it by
   HTTP referrer.
5. Add to your git-ignored `.dev.vars`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_API_KEY=...
   ```
   (`GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` are non-secret; in production
   they're plain `wrangler.jsonc` vars and `GOOGLE_CLIENT_SECRET` is a
   `wrangler secret put`.)

## Build-time variables (optional, production)

These are read at build time (Cloudflare's build environment for the
maintainer's deploy); leave them unset for local dev, tests, and
self-hosting.

- **`VITE_GA_MEASUREMENT_ID`** — a GA4 `G-…` id. Unset → the analytics
  module, the consent banner, and the Settings row all no-op and nothing
  is sent.
- **`SUPPORT_EMAIL`** — shown in the Contact section of `/privacy` and
  `/terms`. Unset → those pages point only at the GitHub issue tracker.
  The pages are generated from `legal/*.html` by
  `scripts/generate-legal.mjs` (runs as `prebuild` / `predev:client`);
  the generated `client/public/{privacy,terms}.html` are git-ignored.
- **`VITE_TURNSTILE_SITE_KEY`** (build) **+ `TURNSTILE_SECRET_KEY`**
  (a `wrangler secret` / `.dev.vars`) — when **both** are set, an
  anonymous visitor opening an "anyone with the link" workspace must
  pass a Cloudflare Turnstile check before live sync starts. Either one
  missing → no widget, no server check; anonymous joins behave exactly
  as before (the dev / test / self-host default). Create a
  non-interactive widget in the Cloudflare dashboard → Turnstile. To
  experiment locally, Cloudflare's always-passes test pair is site
  `1x00000000000000000000AA` / secret
  `1x0000000000000000000000000000000AA` (both stamp a visible
  "testing only" banner on the widget).

## Real-GitHub e2e suite (optional)

The Gist and GitHub-repo **UI flows** have their own opt-in end-to-end
suite that drives the real API proxy endpoints (the rest of the test
suite mocks them). It runs against a throwaway account's fixtures and is
never part of `npm test` / `npm run test:e2e`. To set it up, see
[tests/e2e/github/README.md](tests/e2e/github/README.md). Its CI job
(`e2e-github`) is non-blocking and skips entirely without the repo
secrets.

## How the app works, file structure, dependencies

See [ARCHITECTURE.md](ARCHITECTURE.md).

## Submitting changes

- Keep pull requests focused — one change per PR is easier to review
  than a bundle of unrelated fixes. Use the PR template's Summary/Test
  plan structure.
- Add or update tests for behavior changes where practical (`npm test`).
- Update `CHANGELOG.md` for user-facing changes, and bump the version in
  `package.json` — see `CLAUDE.md`'s versioning section for the
  minor-vs-patch rule and what else moves with it.
- Opening a bug report or feature request? The issue templates
  (`.github/ISSUE_TEMPLATE/`) cover the common cases, or open a blank
  issue.

## Reporting a security issue

Don't open a public issue for security vulnerabilities — see
[SECURITY.md](SECURITY.md).
