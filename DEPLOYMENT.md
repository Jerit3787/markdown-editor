# Deployment

Durable Objects only run on Workers (not static-only Cloudflare Pages),
so the whole app — the built client and the
collaboration/auth/Gist/repo-sync backend — deploys as one Worker.

## Production: automatic

This repo's Cloudflare account is already wired to auto-deploy from
GitHub on every push to `master`. **Merging a PR is the deploy** — there
is no separate manual step for normal shipping. See `CLAUDE.md`'s
"Shipping a change" section for the full PR → merge → tag → release
checklist (tagging and cutting a GitHub Release are themselves automated
by `.github/workflows/auto-tag.yml` and `release.yml`, not part of the
Cloudflare deploy).

## Manual / local deploy

```
npm install
npx wrangler login
npm run deploy
```

`npm run deploy` first runs `predeploy` (`check:no-dev-login` — aborts if
the manual-testing `/api/dev/login` route is still patched into
`src/worker.ts`), then builds the client (`vite build`) and runs
`wrangler deploy`, which reads `wrangler.jsonc`'s static-assets binding
and `WorkspaceRoom`/`CollabRoom` Durable Object migrations and provisions
them. Use this only for a one-off manual push (e.g. testing a deploy
before merging) — it's not part of normal shipping.

Build-time client variables (`VITE_GA_MEASUREMENT_ID`,
`VITE_TURNSTILE_SITE_KEY`, `SUPPORT_EMAIL`) belong in Cloudflare's
**build** environment, not as Worker secrets — see the "Build-time
variables" section in [CONTRIBUTING.md](CONTRIBUTING.md).

## Production secrets

GitHub sign-in (needed for Gist publish/open and Share) requires a
GitHub OAuth App — see the "GitHub OAuth App" section in
[CONTRIBUTING.md](CONTRIBUTING.md) for creating one; use your deployed
domain's URL for the callback instead of `127.0.0.1`.

Once you have the app's credentials:

- `GITHUB_CLIENT_ID` is a plain (non-secret) var, already set in
  `wrangler.jsonc`
- `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` (any random string, used
  to encrypt the session cookie) are Worker secrets, set via:
  ```
  npx wrangler secret put GITHUB_CLIENT_SECRET
  npx wrangler secret put SESSION_SECRET
  ```

Without these, the app still deploys and works — sign-in, Gist, and
Share just won't be available.

### Optional: Cloudflare Turnstile on anonymous joins

To make an anonymous visitor pass a bot check before joining an "anyone
with the link" workspace, create a non-interactive widget in the
Cloudflare dashboard → **Turnstile**, then set **both**:

- `VITE_TURNSTILE_SITE_KEY` — the widget's **site key**, in the
  Cloudflare **build** environment (it is baked into the client bundle).
- `TURNSTILE_SECRET_KEY` — the widget's **secret key**, as a Worker
  secret: `npx wrangler secret put TURNSTILE_SECRET_KEY`.

Leave both unset to disable the check entirely (signed-in collaborators
are never challenged either way).
