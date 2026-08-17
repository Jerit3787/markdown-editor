# Repo Commit History — Design Spec

**TODO item 7.** The foundation of the remaining "repo/workspace metadata
chain" backlog group — items 8 (diffs between commits) and 16
(commit-derived dates) build on whatever this ships, once it exists.

## Goal

A workspace linked to a GitHub repo gets a place to see that repo's real
commit history — not the app's existing local-only Version History
(IndexedDB snapshots, unrelated to git), but the actual git log of the
linked repo/branch, fetched from GitHub.

## Behavior

### 1. Server: list commits

`src/github-repo.ts` gains `handleRepoCommits`, following the exact
proxy pattern `handleRepoList` already uses — no reshaping, the raw
GitHub response passes straight through:

```ts
export async function handleRepoCommits(request: Request, env: Env, owner: string, repo: string, branch: string, page: number): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&page=${page}&per_page=30`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

`src/worker.ts` gains a new route, matching `REPO_TREE_PATH`'s existing
style:

```ts
const REPO_COMMITS_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/commits$/;
```

```ts
const repoCommitsMatch = url.pathname.match(REPO_COMMITS_PATH);
if (repoCommitsMatch && request.method === "GET") {
  const branch = url.searchParams.get("branch") || "";
  const page = Number(url.searchParams.get("page")) || 1;
  return handleRepoCommits(request, env, repoCommitsMatch[1]!, repoCommitsMatch[2]!, branch, page);
}
```

Pagination: GitHub's `per_page=30` is fixed server-side (not
client-configurable) — the client detects "no more pages" by checking
whether a response came back with fewer than 30 items, rather than
parsing GitHub's `Link` header.

### 2. Client: `RepoInfoPanel.svelte`

A new store, `client/src/stores/repoInfoPanel.ts`, mirrors
`docInfoPanel.ts` exactly:

```ts
import { writable } from "svelte/store";

export const repoInfoPanelOpen = writable(false);
```

A new component, `client/src/components/RepoInfoPanel.svelte`, modeled
on `DocInfoPanel.svelte`'s `Modal`-based overlay pattern: shows the
linked workspace's repo (owner/repo/branch, linking out to the repo on
GitHub), then a scrollable list of commits below it — each row shows the
commit message (first line only), author name, and a relative
timestamp (`window.MDE.formatRelativeTime`), and links out to that
commit's page on GitHub. A "Load more" button at the bottom fetches the
next page and appends to the list; it hides itself once a fetch returns
fewer than 30 commits. Fetches happen directly via `fetch()` inside the
component (matching `RepoPicker.svelte`'s style for simple read-only
calls), not routed through `repo-sync.ts`.

Opening the panel is gated behind the same `requireRepoScope()` check
`repo-sync-ui.ts`'s pull/push/link actions already use — this app's
existing GitHub OAuth scope model doesn't distinguish read-only repo
access from write access, so a session without repo scope can't read
commit history from a private repo either. `requireRepoScope()` is
module-private in `repo-sync-ui.ts` today (not exported), and per that
file's own header comment, `MenuBar.svelte` is meant to only ever touch
`window.MDE` and stores — never import a feature module's functions
directly. So `repo-sync-ui.ts` gains one new bridge function, matching
`openRepoLinkModal`'s existing shape exactly:

```ts
window.MDE.openRepoInfoPanel = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    repoInfoPanelOpen.set(true);
  })();
};
```

`client/src/types.ts`'s `MDEBridge` interface gains the matching
declaration, alongside `openRepoLinkModal`/`openRepoModal`:

```ts
openRepoInfoPanel?(): void;
```

`MenuBar.svelte`'s GitHub Repo submenu gains a new entry, "Repo info",
alongside the existing Pull/Push/Unlink buttons (shown only when
`hasRepoLink` is true), calling `window.MDE.openRepoInfoPanel?.()` — the
same `?.()` optional-call pattern every other `window.MDE` menu action in
this file already uses.

`RepoInfoPanel.svelte` needs mounting, same three-part pattern every
other overlay component in this app already follows (see
`DocInfoPanel`/`VersionHistory`/`RepoLinkModal` for the precedent): a new
`<div id="repo-info-panel-mount">` in `client/index.html`, an import and
a `mount(RepoInfoPanel, { target: document.getElementById("repo-info-panel-mount")! })`
call in `client/src/main.ts`.

## Non-goals (deferred)

- **Diffing between two commits.** Item 8's job, once this ships.
- **Deriving document created/modified dates from commit data.** Item
  16's job, once this ships.
- **Per-document sync-status display** (which docs are up to date, which
  have unpushed changes) inside this panel. `Document Info` already
  shows this per-document; a workspace-wide rollup is a plausible future
  addition but not part of this spec.
- **Configurable page size or a "jump to date" filter.** A fixed 30 per
  page with manual "Load more" is the whole pagination story here.

## Error handling

`handleRepoCommits` returns whatever status GitHub's API returns
(proxied via `proxyJson`, matching every other read endpoint in this
file) — a 404 branch, a rate-limited response, etc. all pass through
as-is. `RepoInfoPanel.svelte` shows a toast (`showToast(..., "error")`,
matching this app's established pattern) if a fetch fails, and leaves
whatever commits were already loaded in place rather than clearing the
list.

## Testing

- `src/github-repo.test.ts`: `handleRepoCommits` returns 401 when signed
  out; proxies the GitHub response body/status through unchanged
  (mirrors `handleRepoList`'s own test); constructs the correct upstream
  URL including `sha`, `page`, and a fixed `per_page=30`.
- No automated coverage for `RepoInfoPanel.svelte` or the "Load more"
  pagination flow — matches this codebase's established precedent (no
  Svelte component tests). Manual verification: link a workspace to a
  repo with commit history, open File > GitHub Repo > Repo info, confirm
  the commit list loads with correct messages/authors/relative dates and
  links out to GitHub correctly; click "Load more" and confirm it
  appends further commits; confirm the button disappears once history is
  exhausted (works cleanly against a repo with fewer than 30 commits
  total, where the very first page already comes back short).
