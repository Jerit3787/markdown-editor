# Repo Commit Doc Dates — Design

**TODO item:** #16 — "use commit information to determine date created and last modified. [requires 8]" (item 8 is done: Version History now merges local snapshots with repo commits).

## Problem

`Doc.createdAt` / `Doc.updatedAt` (`client/src/types.ts`) are local-only timestamps. For a repo-linked document, both are set to `Date.now()` at the moment the file is pulled into the app (`upsertDocFromRepo`, `client/src/stores/docs.ts:456-496`) — so pulling an existing repo with years of history shows every file as "created just now." `updatedAt` is also bumped on every local content edit (`docs.ts:174`), independent of whether that edit has been pushed.

The Document Info panel (`client/src/components/DocInfoPanel.svelte`) is the one place these are shown precisely — "Created" and "Edited" rows with both a relative and full timestamp. For a repo-linked doc, this should instead reflect the file's real git history.

## Scope

- **Display-only, `DocInfoPanel.svelte` only.** No changes to `doc.createdAt` / `doc.updatedAt` themselves, no schema change, no persistence of repo-derived dates. The sidebar doc list, "Open Recent" menu, and Command Palette keep sorting and labeling by local edit recency exactly as today — that's a "what did I just touch" aid, not a history record, and populating it from repo data would mean a GitHub API call per visible row.
- **Repo-linked docs only** (`doc.repoPath` set and the doc's workspace has a `repoLink`). Non-repo docs are untouched.
- Both "Created" and "Edited" are derived from true repo commit history (not just "Created") — including commits from other collaborators or other sessions not yet reflected in local state.

## Data source

Reuses the existing commits endpoint already used by Version History:
`GET /api/repo/{owner}/{repo}/commits?branch=...&path=...&page=N` → `src/github-repo.ts`'s `handleRepoCommits`, which proxies GitHub's `GET /repos/{owner}/{repo}/commits`. Commits come back newest-first. `commit.author.date` is the field to use — same field Version History already keys off (`VersionHistory.svelte:90`), for consistency.

**Finding the oldest commit without paging through everything:** GitHub has no "oldest first" option, but its pagination `Link` response header carries a `rel="last"` URL naming the final page number. So:

1. Fetch page 1 → `commits[0].commit.author.date` is "Edited."
2. Parse the response's `Link` header for `rel="last"`.
   - Absent → the whole history fit on page 1 (≤30 commits); the last item in that same array is "Created."
   - Present → fetch that last page; its last item is "Created."

This reaches the origin commit in at most 2 requests regardless of history length.

**Backend change required:** `proxyJson` in `src/github-repo.ts` (used by 7 handlers) currently forwards only `Content-Type`, dropping every other response header including `Link`. It needs to forward `Link` when present. This is additive and safe for every other caller — a response with no `Link` header simply forwards nothing new.

## Fallback behavior

Silent fallback to local timestamps (no error UI) when:
- The doc isn't repo-linked.
- The fetch fails (network, auth, rate limit).
- The repo has zero commits for that path yet (file created locally, never pushed).

This is a best-effort enrichment layered on top of always-available local timestamps, not a hard dependency.

**Known limitation:** GitHub's `path` filter does not follow renames — it matches the literal current path across history. A renamed file's "Created" will reflect its arrival at the *current* filename, not its original commit under the old name. Same limitation Version History's commit list already carries; not addressed here.

## Loading UX

Local timestamps render immediately when the panel opens — no spinner, no loading flicker on the common case. If the repo fetch resolves with different values, the "Created" and "Edited" rows update in place. If the user switches to a different document while a fetch is in flight, the stale result is discarded (a request token or `AbortController`) so it can never overwrite a different document's display.

## Testing

- Server: a test that `proxyJson` forwards a `Link` header when GitHub's response includes one, and forwards nothing extra when it doesn't (covers all 7 callers by exercising the shared helper directly).
- Client: `DocInfoPanel` tests with mocked `fetch` covering — single-page history (Created = last item of page 1, no second request made), multi-page history (second request made for the last page, Created = its last item), empty commit array (falls back to local timestamps), fetch rejection (falls back to local timestamps), and rapid doc-switch (first doc's late-arriving response does not overwrite the second doc's display).
