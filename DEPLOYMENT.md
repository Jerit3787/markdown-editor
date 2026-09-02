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

`npm run deploy` builds the client (`vite build`) then runs
`wrangler deploy`, which reads `wrangler.jsonc`'s static-assets binding
and `WorkspaceRoom`/`CollabRoom` Durable Object migrations and provisions
them. Use this only for a one-off manual push (e.g. testing a deploy
before merging) — it's not part of normal shipping.

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
