# Manual testing scripts

Local-only end-to-end tests for workspace-level sharing, exercising the
real `WorkspaceRoom` Durable Object and client through `npm run dev`
rather than mocks. Neither script touches production — both talk to
`http://localhost:8787` only.

## Prerequisites

Both scripts sign in without going through real GitHub OAuth, using a
temporary route this repo does **not** ship in `src/worker.ts` (it must
never be committed — it makes it trivial to mint a session for any
username with zero credentials). Apply it locally:

```
bash scripts/manual-testing/enable-dev-login.sh   # patches src/worker.ts, creates .dev.vars
npm run build && npm run dev
```

When you're done testing, **always** remove it again before touching git:

```
bash scripts/manual-testing/disable-dev-login.sh
```

`enable-dev-login.sh` applies `dev-login.patch` via `git apply` and
refuses to run if `src/worker.ts` already has other uncommitted changes
(to avoid ever repeating the mistake of it getting swept into an
unrelated commit). `disable-dev-login.sh` reverses it and confirms the
file matches `HEAD` again. If you ever need to touch `src/worker.ts`
for real (unrelated to testing) while the patch is applied, run
`disable-dev-login.sh` first, make your change, commit, then
`enable-dev-login.sh` again if you still need to keep testing.

Note: `/api/auth/github/me` actively re-verifies the session token
against GitHub's real API (see the project's own memory notes) — a fake
`dev-fake-token` correctly fails that check, so both
`e2e/collab/support/dev-login.ts` (`signInAsDevUser`) and
`simulate-collaborator-ws.mjs`/`repo-sync-e2e.mjs` below intercept that
one request at the network level rather than relying on the dev-login
cookie for anything gated by `window.MDE.githubUsername`. Server-side
Durable Object authorization is unaffected either way — it only
decrypts the session locally.

## Scripts

The two-browser-context live-sync scenario formerly covered here by
`two-user-live-sync.mjs` is now a formal, assertion-based Playwright
test: `e2e/collab/live-sync.spec.ts`, run via `npm run test:e2e:collab`
(see `scripts/e2e-collab.sh` for the automated
enable-dev-login → build → wrangler dev → test → disable-dev-login
cycle this section used to require doing by hand).

### `simulate-collaborator-ws.mjs`

A second collaborator at the raw WebSocket/Yjs protocol level, no
browser involved — useful for isolating server-side `WorkspaceRoom`
behavior from any client-side code. Prints the document content it
receives after the sync handshake, then sends a live edit and holds
the connection open briefly.

```
node scripts/manual-testing/simulate-collaborator-ws.mjs <workspaceId> <docId> <sessionCookie>
```

Get a `workspaceId`/`docId` from a real share link, and a
`sessionCookie` via `curl -sD - "http://localhost:8787/api/dev/login?username=test-collaborator"`.

### `repo-sync-e2e.mjs`

Manual, interactive E2E for GitHub repo sync. Requires a real disposable
test repo you're OK pushing test commits to, and a real GitHub OAuth
sign-in (this script pauses and waits for you to sign in through the
actual popup — repo-sync calls need a real GitHub API token with the
`repo` scope, which the dev-login route's fake session cookie does not
provide; see the Prerequisites note above about why `/api/auth/github/me`
fails a fake token here even though the other two scripts work fine
with it).

```
node scripts/manual-testing/repo-sync-e2e.mjs <your-username>/<test-repo>
```

Creates a doc, links the active workspace to the given repo, pushes, and
prints the commits URL to verify by hand.
