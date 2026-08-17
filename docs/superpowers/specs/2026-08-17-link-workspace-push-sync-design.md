# Link Existing Workspace Pushes + Pulls on Link — Design Spec

**TODO item 3.** Builds on the shipped GitHub Repo Sync (v1.22.0,
`docs/superpowers/specs/2026-08-17-github-repo-sync-design.md`) and
Open-Repo-as-Workspace features. Linking a workspace to a repo today
(`RepoLinkModal.svelte`'s `linkWorkspace()`) only calls
`setWorkspaceRepoLink()` — it saves the link but does nothing with the
workspace's existing documents or the repo's existing content. The user
has to remember to manually click "Push to Repo" (and "Pull from Repo",
if they also want the repo's other content) from the GitHub Repo submenu
afterward.

## Goal

Linking an existing workspace to a repo should immediately reconcile the
two: push the workspace's local documents out, then pull in anything the
repo already has that isn't one of those just-pushed docs. One action,
both directions, no manual follow-up required for the common case.

## Non-goals (deferred)

- **New progress UI.** This reuses the existing `repoSyncBusyLabel` store
  and `showToast` pattern already used by the manual Pull/Push actions.
  A richer progress modal is TODO item 5, a separate piece of work.
- **Merge/dedup logic beyond what already exists.** Path collisions
  between a local doc's assigned slug and an existing repo file are
  handled by the existing `dedupeRepoPath()` — nothing new is introduced
  here.
- **Changes to "Open repo as new workspace"** (`createWorkspaceFromRepo`
  in `repo-sync.ts`). That flow creates an empty workspace and pulls into
  it — there's nothing local to push, so it's unaffected.
- **Automatic resolution of genuine conflicts.** If the repo's tree moves
  between this flow's push and pull steps (e.g. a concurrent external
  push), any resulting conflicts/deletions route through the existing
  shared `repoConflictModal`, unchanged.

## Behavior

### The stale-metadata problem

`clearWorkspaceRepoLink()` (used by "Unlink Repo") only clears
`workspace.repoLink` — it never resets `doc.repoPath`/`repoSha`/
`repoImageShas` on the workspace's documents. If a workspace is later
linked to a *different* repo that happens to have a same-named file, the
push planner would compare the doc's stale SHA (from the old repo)
against the new repo's tree SHA at that path and incorrectly report a
push conflict, even though this is really the first sync to the new repo.

Linking a workspace must always start a clean sync relationship: every
doc's `repoPath`/`repoSha`/`repoImageShas` is cleared as part of the link
action, before anything is pushed or pulled.

### `linkWorkspaceAndSync`

New orchestrator in `client/src/repo-sync.ts`, replacing the direct
`setWorkspaceRepoLink()` call currently made by `RepoLinkModal.svelte`'s
`linkWorkspace()`:

```ts
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<void> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  await pushToRepo(workspaceId, repoLink);
  await pullFromRepo(workspaceId, repoLink, new Set());
}
```

Steps:

1. `setWorkspaceRepoLink` — unchanged, existing function.
2. `clearRepoSyncMetadata(workspaceId)` — new function in
   `client/src/stores/docs.ts`. Strips `repoPath`, `repoSha`, and
   `repoImageShas` from every doc in the workspace. Mirrors the shape of
   the existing `removeDocsByRepoPaths`/`setDocRepoLinkById` functions in
   the same file.
3. `pushToRepo(workspaceId, repoLink)` — reused as-is, no changes. Since
   every doc now has no `repoPath` (just cleared in step 2), `planPush`
   treats every doc as new: it assigns each a deduped path
   (`dedupeRepoPath`) and pushes it. A doc with no `repoPath` can never
   produce a push conflict — `planPush` only checks the tree SHA against
   `doc.repoSha` when a `repoPath` is already set — so this step cannot
   fail with a conflict.
4. `pullFromRepo(workspaceId, repoLink, new Set())` — reused as-is. The
   tree fetched here now contains the paths just pushed in step 3, plus
   whatever else already existed in the repo. Docs matching their own
   just-pushed path are unchanged (their `repoSha` was set by step 3's
   push and matches the tree, so `planPull` skips them). Any tree entries
   with no matching local doc become new local docs — this is what pulls
   in the repo's pre-existing content.
5. If `pullFromRepo`'s plan reports conflicts or pending deletions (only
   possible if the tree moved between steps 3 and 4 — e.g. a concurrent
   external push), the caller routes them through the existing shared
   `repoConflictModal`, exactly like the manual "Pull from Repo" action
   does today.

This flow cannot introduce data loss: nothing local is ever deleted or
overwritten by the push step (only newly-assigned paths are written), and
the pull step only creates new docs or applies non-conflicting fast-
forward updates to the docs this same flow just pushed.

### `RepoLinkModal.svelte`

`linkWorkspace()` changes from:

```ts
function linkWorkspace(owner: string, repo: string, branch: string) {
  const workspaceId = $activeWorkspaceIdStore;
  if (!workspaceId) return;
  setWorkspaceRepoLink(workspaceId, { owner, repo, branch });
  close();
  showToast(`Linked to ${owner}/${repo}`, "success");
}
```

to:

```ts
async function linkWorkspace(owner: string, repo: string, branch: string) {
  const workspaceId = $activeWorkspaceIdStore;
  if (!workspaceId) return;
  repoSyncBusyLabel.set("Pushing…");
  try {
    await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
    close();
    showToast(`Linked to ${owner}/${repo}`, "success");
  } catch (err: any) {
    showToast(err.message || "Couldn't sync after linking", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
}
```

`linkWorkspaceAndSync` itself flips `repoSyncBusyLabel` from
`"Pushing…"` to `"Pulling…"` between its push and pull steps (mirroring
how the existing manual Pull/Push menu actions set this same store), so
the GitHub Repo submenu's busy-state label — already wired to
`$repoSyncBusyLabel` — reflects both phases without any new UI.

`RepoPicker`'s `onPick` prop is awaited by the caller already (see the
Open-Repo-as-Workspace work), so its own busy-state UI (disabling the
picked repo's row, showing "Linking…") naturally covers this longer
push+pull duration with no changes needed in `RepoPicker.svelte`.

### Error handling

- If `pushToRepo` throws (network failure, HTTP error): the workspace is
  already linked (step 1 already ran) but nothing was pushed or pulled.
  Error toast shown; the user can retry via the ordinary "Push to Repo"
  menu action once the modal closes — this matches the spec's existing
  "link stays even if a later action fails" behavior for the manual
  actions.
- If `pushToRepo` succeeds but `pullFromRepo` throws: the push already
  landed as real commits. Error toast shown; the user's local docs are
  fully synced to the repo, they've just not yet pulled in the repo's
  other pre-existing content — retried via the ordinary "Pull from Repo"
  menu action.
- Conflicts/deletions surfaced by the pull step: existing
  `repoConflictModal` flow, unchanged.

## Testing

### Fake GitHub server harness (new, shared test infrastructure)

Raised during design review: this codebase's client-side repo-sync
orchestrators (`pullFromRepo`, `pushToRepo`, `createWorkspaceFromRepo`,
and now `linkWorkspaceAndSync`) have never had automated coverage —
only their pure planners (`planPull`, `planPush`,
`planCreateWorkspaceFromRepo`) do, with the orchestrators themselves
verified solely by manual E2E
(`scripts/manual-testing/repo-sync-e2e.mjs`, which requires a real GitHub
repo and a human to sign in). `linkWorkspaceAndSync` is the first
orchestrator whose correctness genuinely depends on a multi-step
sequence against *evolving* remote state (push, then a pull that must see
the just-pushed content) — exactly the case manual E2E and one-shot fetch
mocks are worst at catching regressions in.

New file: `src/test-support/fake-github-server.ts`. A plain Node
`http.createServer` (no new dependency) implementing exactly the GitHub
Git Data API endpoints `src/github-repo.ts` calls:

- `GET /repos/:owner/:repo/git/refs/heads/:branch`
- `GET /repos/:owner/:repo/git/trees/:sha?recursive=1` (accepts either a
  commit sha or a tree sha, matching real GitHub's dual behavior — this
  file's `handleRepoTree` always passes a commit sha)
- `GET /repos/:owner/:repo/git/blobs/:sha`
- `POST /repos/:owner/:repo/git/blobs`
- `POST /repos/:owner/:repo/git/trees`
- `POST /repos/:owner/:repo/git/commits`
- `PATCH /repos/:owner/:repo/git/refs/heads/:branch`

Backed by real mutable in-memory state (refs → commits → trees → blobs
per `owner/repo`), so a push through this server genuinely changes what a
later tree/blob fetch returns — not a sequence of canned one-shot
responses. Blob SHAs are computed with the same git blob SHA1 algorithm
`client/src/repo-sync.ts`'s `gitBlobSha` already uses (`sha1("blob " +
byteLength + "\0" + content)`), so a pushed blob's SHA is a real,
independently-verifiable value, not a fake placeholder. `PATCH refs/heads`
only accepts the update when the pushed commit's `parents[0]` matches the
ref's current commit sha (a real fast-forward check) — otherwise it
responds the same way real GitHub does on a rejected ref update, so the
existing 409-conflict path in `handleRepoPush`/`pushToRepo` can be
exercised for real, not just simulated with a canned 422.

Exports:

```ts
export interface FakeGithubServer {
  baseUrl: string; // e.g. "http://127.0.0.1:54231"
  seedRepo(owner: string, repo: string, branch: string, files: { path: string; content: string }[]): void;
  stop(): Promise<void>;
}
export function startFakeGithubServer(): Promise<FakeGithubServer>;
```

`seedRepo` creates blobs/tree/commit/ref for the given files as one
initial commit, simulating "this repo already has content" — the exact
scenario `linkWorkspaceAndSync` needs to prove itself against.

### `linkWorkspaceAndSync` integration test

In `client/src/repo-sync.test.ts` (same file as the other repo-sync
tests, `// @vitest-environment jsdom` pragma already present): starts a
`fakeGithubServer` in a `beforeEach`, stops it in `afterEach`. Stubs
`global.fetch` once per test with a router that:

- For a URL matching `/api/repo/:owner/:repo/tree`, `/blob/:sha`, or
  `/push` — calls the real `handleRepoTree`/`handleRepoBlob`/
  `handleRepoPush` from `src/github-repo.ts` directly (constructing a
  `Request` with a valid signed session cookie, reusing the
  `sessionCookieHeader` helper pattern from `src/github-repo.test.ts`)
  and returns the real `Response`.
- For a URL starting with `https://api.github.com` — rewrites the origin
  to `fakeGithubServer.baseUrl` and performs a real `fetch` against it.

This means the test exercises the *real* client orchestration
(`linkWorkspaceAndSync` → `pushToRepo`/`pullFromRepo`) calling into the
*real* server proxy/commit-building logic
(`handleRepoTree`/`handleRepoBlob`/`handleRepoPush`, completely
unmodified) against a *real* local server with real, mutable state — the
only things not real are the Cloudflare Worker's own routing layer and
actual GitHub.

Test case: seed the fake server with one pre-existing file
(`existing.md`), create a local workspace with one doc with local
content, call `linkWorkspaceAndSync`. Assert, after the call:

- The local doc now has a `repoPath`/`repoSha` set (it was pushed).
- A GET to the fake server's tree endpoint shows both the newly-pushed
  path and the original `existing.md`, proving the push didn't touch
  unrelated content.
- A second local doc now exists in the workspace, sourced from
  `existing.md` (proving the pull step picked up the repo's pre-existing
  content).

A second test covers `clearRepoSyncMetadata`'s bug fix directly: seed a
doc with stale `repoPath`/`repoSha` from a different (unrelated) prior
repo, link to a repo whose tree already has a file at that same path with
different content, and assert no conflict is raised — the stale metadata
was cleared, so the push treats it as a brand-new path (deduped if
needed) rather than comparing against the old repo's SHA.

### Unit test for `clearRepoSyncMetadata`

In `client/src/stores/docs.test.ts`: a doc with `repoPath`/`repoSha`/
`repoImageShas` set has all three cleared after the call; a doc in a
different workspace is untouched.

### Manual E2E verification

Still run once by hand after implementation, per this codebase's existing
practice for repo-sync features: link a workspace with existing docs to a
real repo that itself already has `.md` content, confirm the resulting
repo state and local workspace state match what the integration test
above asserts. This isn't a substitute for the integration test — it's
the final "does this also work against real GitHub, not just our fake"
check the manual-testing scripts in this repo already exist for.
