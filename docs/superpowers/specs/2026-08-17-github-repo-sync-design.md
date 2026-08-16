# GitHub Repo Sync — Design Spec

**Sub-project 3 of the workspace pivot.** Sub-project 1 (Workspace core,
v1.20.0) and sub-project 2 (Workspace-level sharing, v1.21.0) are shipped.
This spec covers linking a workspace to a GitHub repo, pulling its
contents in, and pushing workspace state back out.

## Goal

Let a workspace optionally back onto a GitHub repo, the same way it can
optionally live-share with collaborators (sub-project 2) — a separate,
independent link. A user can pull an existing notes/docs repo into a
workspace, keep editing locally (with or without live collaborators), and
push changes back as real commits.

## Non-goals (deferred)

- **Continuous/automatic sync.** This is explicit pull/push, like the
  existing Gist flow — not a background process, and not merged with
  sub-project 2's live Yjs sync. The two features coexist but don't
  interact: pushing/pulling reads/writes whatever the workspace's current
  local content is, regardless of whether it's also being live-shared.
- **Subfolder-scoped or non-recursive linking.** A linked workspace always
  maps to the whole repo tree on a chosen branch, recursively. Linking to
  just a subfolder, or only the root without recursion, is not supported
  in this version.
- **Automatic merging.** Conflicts are always surfaced to the user for a
  per-file "keep mine / take theirs" decision — never silently resolved.
- **Non-markdown file types.** Only `.md` files become docs. Other files
  in the repo (images referenced by synced docs excepted — see below) are
  left untouched by pull/push and never appear in the workspace.
- **Google Drive sync** (sub-project 4) — separate integration, separate
  spec.

## Data Model

```ts
// client/src/types.ts — Workspace gains:
interface Workspace {
  // ...existing fields...
  repoLink?: {
    owner: string;
    repo: string;
    branch: string;
  };
}

// Doc gains (parallel to gistId/gistFilename):
interface Doc {
  // ...existing fields...
  repoPath?: string;                    // e.g. "docs/notes.md"
  repoSha?: string;                     // last-known blob SHA at repoPath
  repoImageShas?: Record<string, string>; // image/diagram ref -> last-known blob SHA
}
```

`repoSha`/`repoImageShas` are this feature's conflict-detection
mechanism: GitHub's Contents/Git Data APIs already key file identity by
blob SHA, so "the remote changed since we last synced" is just "the
current tree's SHA at this path doesn't match what we stored."

## Server: `src/github-repo.ts`

New endpoints, parallel to the existing Gist ones in `src/worker.ts`,
using the same encrypted-cookie session as `src/github-auth.ts`:

- `GET /api/repo/list` — the signed-in user's repos (`GET /user/repos`),
  for the linking picker.
- `POST /api/repo/create` — create a new repo (`POST /user/repos`), name +
  public/private.
- `GET /api/repo/:owner/:repo/tree?branch=` — proxies
  `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`, returns the
  filtered `.md`-relevant tree.
- `GET /api/repo/:owner/:repo/blob/:sha` — proxies
  `GET /repos/{owner}/{repo}/git/blobs/{sha}`, for pulling file/image
  content.
- `POST /api/repo/:owner/:repo/push` — the atomic push (see below): body
  carries the branch, the base tree SHA the client last read, and the set
  of blob creates/updates/deletes to apply. Server performs the
  blob → tree → commit → ref-update sequence server-side (keeps the
  GitHub token off the client, matching how Gist calls already work).

### OAuth scope change

`handleLogin`'s requested scope changes from `"gist"` to `"repo"`.
`handleMe` starts returning the scopes actually granted to the current
token (captured from GitHub's `X-OAuth-Scopes` response header during
token exchange, stored alongside the session). The client checks for
`repo` before allowing any repo-sync action; a signed-in user whose token
predates this change sees a "re-connect GitHub" prompt instead of a
confusing API failure.

## Client: `client/src/github-repo.ts` + UI

Parallel to `gist.ts`. New pieces:

- **Link modal** (workspace-level action, next to Share): repo
  picker/paste/create, then branch selection, then saves
  `workspace.repoLink`.
- **Pull action**: fetches the tree, diffs against every doc's
  `repoPath`/`repoSha` in the workspace, applies non-conflicting changes,
  and — if any conflicts or pending deletions were found — opens the
  conflict/deletion-confirmation modal before finishing.
- **Push action**: computes each doc's pushable content (images/diagrams
  rewritten to relative repo paths, mirroring `pushImagesAndRewrite`),
  diffs against last-known SHAs, and — if clean — sends the change set to
  `POST /api/repo/:owner/:repo/push`. Conflicts open the same shared
  modal as pull before continuing.
- **Conflict/deletion modal**: one shared component. Lists affected docs;
  "keep mine" / "take theirs" per item for conflicts, a plain
  confirmation list for pending deletions.

### Pull details

1. Fetch the recursive tree.
2. Match `.md` blobs against existing docs by `repoPath`:
   - No matching doc → create one.
   - Tree SHA == doc's `repoSha` → unchanged, skip.
   - Tree SHA differs, doc unedited since last sync → apply, update
     `repoSha`.
   - Tree SHA differs, doc has local edits → queue as a conflict.
3. Docs with a `repoPath` no longer present in the tree → queue as a
   pending deletion, shown as a batch confirmation ("3 docs will be
   removed — deleted from the repo").
4. For each pulled doc, find relative image links in its content, fetch
   the referenced blobs, fold them into `doc.images`/`doc.diagrams`
   keyed by a generated ref, and rewrite the markdown back to internal
   ref syntax (mirrors `extractInlineImages`, but resolving repo-relative
   paths instead of scanning for embedded base64).

### Push details

1. Fetch the current tree fresh (same call as pull step 1) — push never
   reuses a tree read from an earlier pull, to keep the window between
   "read remote state" and "diff against it" as short as possible.
2. For each doc, compute pushable content: resolve `doc.images`/
   `doc.diagrams` to relative paths under `assets/<doc-slug>/`, rewrite
   the markdown accordingly (mirrors `pushImagesAndRewrite`'s approach,
   targeting repo-relative paths instead of gist URLs).
3. Diff against the freshly-fetched tree: unchanged → skip. A doc with no
   `repoPath` yet gets one assigned (slugified from its name, de-duplicated
   against the current tree). Remote SHA at an existing path differs from
   what's stored on the doc (`repoSha`/`repoImageShas`) → queue as a
   conflict.
4. If no unresolved conflicts remain, send the full change set (creates,
   updates, deletes, plus the tree SHA fetched in step 1 as `base_tree`)
   to the push endpoint.
4. Server builds one atomic commit: blobs for every changed file → a new
   tree (`base_tree` = the branch head's current tree, changed paths
   added/updated, deleted paths omitted) → a commit (parent = current
   branch head) → `PATCH git/refs/heads/{branch}` with `force: false`. A
   rejected ref update (branch moved since the client's base tree SHA was
   read) comes back as a conflict response — the client re-pulls the tree
   and re-runs the diff rather than retrying blindly.
5. On success, update every pushed doc's `repoSha`/`repoImageShas` from
   the response.

## Error Handling

- Missing/insufficient OAuth scope → explicit re-auth prompt, not a raw
  API error.
- Network/API failures → `showToast` + the existing `errorMessage()`
  helper pattern from `gist.ts`.
- 404 on a linked repo (deleted, renamed, access revoked) → clear,
  specific message, workspace's `repoLink` is left in place (user can
  re-link or unlink explicitly) rather than silently cleared.
- Rejected ref update on push → treated as a conflict requiring a re-pull,
  not a generic failure.

## Testing

- Server: unit tests for tree-diffing, conflict detection, and
  blob/tree/commit-building logic, with GitHub API calls mocked — same
  style as `src/workspace-room.test.ts`.
- Client: unit tests for doc↔path mapping, image rewrite/extract
  functions, and conflict-detection comparisons.
- Manual E2E: a new Playwright script under `scripts/manual-testing/`
  (using the existing dev-login patch) against a real disposable test
  repo — link, push, verify the resulting commit, pull, verify round-trip
  fidelity (including images).
