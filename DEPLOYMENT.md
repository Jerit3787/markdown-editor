# Deployment

Durable Objects only run on Workers (not static-only Cloudflare Pages),
so the whole app — the built client and the collaboration/auth/Gist
backend — deploys as one Worker.

## First-time setup

```
npm install
npx wrangler login
```

## Deploy

```
npm run deploy
```

`npm run deploy` builds the client (`vite build`) then runs
`wrangler deploy`, which reads `wrangler.jsonc`'s static-assets binding
and `CollabRoom` Durable Object migration and provisions both.

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
