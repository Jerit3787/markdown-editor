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

Run the test suite with `npm test` (Vitest).

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

## How the app works, file structure, dependencies

See [ARCHITECTURE.md](ARCHITECTURE.md).

## Submitting changes

- Keep pull requests focused — one change per PR is easier to review
  than a bundle of unrelated fixes.
- Add or update tests for behavior changes where practical (`npm test`).
- Update `CHANGELOG.md` for user-facing changes.

## Reporting a security issue

Don't open a public issue for security vulnerabilities — see
[SECURITY.md](SECURITY.md).
