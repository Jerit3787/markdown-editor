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
`dev-fake-token` correctly fails that check, so `two-user-live-sync.mjs`
intercepts that one request at the network level (`stubGithubIdentity`)
rather than relying on the dev-login cookie for anything gated by
`window.MDE.githubUsername`. Server-side Durable Object authorization is
unaffected either way — it only decrypts the session locally.

## Scripts

### `two-user-live-sync.mjs`

Two fully independent Playwright browser contexts (separate cookie
jars) simulating two real collaborators end-to-end: alice creates a
document, shares it (exercising the relocate-into-its-own-workspace
flow), bob opens the resulting `/w/<id>/<id>/edit` link, goes through
the join-workspace modal, and the test asserts bob actually received
alice's seeded content — then that a live edit from alice appears in
bob's browser with no reload.

```
node scripts/manual-testing/two-user-live-sync.mjs
```

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
