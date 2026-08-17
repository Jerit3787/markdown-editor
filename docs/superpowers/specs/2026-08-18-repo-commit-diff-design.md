# Repo Commit Diff — Design Spec

**TODO item 8** ("adapt versioning history to able to see diffs between
commits"), Phase 1 of 2. This phase adds diffing to the just-shipped Repo
Commit History (`RepoInfoPanel.svelte`, see
`docs/superpowers/specs/2026-08-18-repo-commit-history-design.md`) — diffing
two arbitrary local Version History snapshots is Phase 2, a separate spec,
reusing the diff-rendering piece this phase builds. Item 16 ("use commit
information to determine date created and last modified") depends on
whatever Phase 1 ships here, per this session's TODO decomposition.

## Goal

From the Repo Info panel, a user can pick any two commits and see how the
currently-open document's content differs between them — a real git diff,
not a local-snapshot diff (that's Phase 2's job).

## Behavior

### 1. Diff computation: `client/src/diff-lines.ts`

No diffing library exists anywhere in this codebase today (confirmed via a
full dependency scan). This app adds `diff` (npm, Myers line-diff
algorithm, MIT-licensed, no runtime dependencies of its own) rather than
hand-rolling a diff algorithm or pulling in `@codemirror/merge` — the
latter is built for editable merge conflicts and would mean mounting two
synced CodeMirror instances just to render a static diff, more machinery
than a read-only comparison needs.

The approved side-by-side mockup pairs a replaced line's old and new text
on the *same* row (not on two separate rows with a blank counterpart each)
— so the wrapper must do more than flatten `diffLines`' output; it must
pair up a removed run with an immediately-following added run (the shape
`diffLines` produces for a single-line-or-block replacement), row by row,
and only fall back to a blank counterpart for the surplus when one run is
longer than the other (a pure insertion or deletion with no replacement
partner). A thin wrapper keeps the raw import in one place, the same way
this app already wraps other third-party libraries behind an owned module:

```ts
import { diffLines, type Change } from "diff";

export interface DiffRow {
  leftText: string | null; // null = blank counterpart cell (this row is add-only)
  rightText: string | null; // null = blank counterpart cell (this row is remove-only)
  type: "same" | "changed" | "removed" | "added";
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing split artifact from a final newline
  return lines;
}

// Pairs a removed run with an immediately-following added run (the shape
// diffLines produces for a same-position replacement) so replaced lines
// share one row instead of stacking as separate remove/add rows.
export function computeDiffRows(before: string, after: string): DiffRow[] {
  const changes: Change[] = diffLines(before, after);
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < changes.length) {
    const change = changes[i]!;
    if (!change.added && !change.removed) {
      for (const text of splitLines(change.value)) rows.push({ leftText: text, rightText: text, type: "same" });
      i++;
      continue;
    }
    const next = changes[i + 1];
    const pairsWithNext = change.removed && next?.added;
    const removedLines = change.removed ? splitLines(change.value) : [];
    const addedLines = pairsWithNext ? splitLines(next!.value) : change.added ? splitLines(change.value) : [];
    const pairCount = Math.max(removedLines.length, addedLines.length);
    for (let j = 0; j < pairCount; j++) {
      const l = removedLines[j] ?? null;
      const r = addedLines[j] ?? null;
      rows.push({ leftText: l, rightText: r, type: l !== null && r !== null ? "changed" : l !== null ? "removed" : "added" });
    }
    i += pairsWithNext ? 2 : 1;
  }
  return rows;
}
```

### 2. Shared component: `client/src/components/DiffView.svelte`

Takes `before: string` and `after: string` props. Calls `computeDiffRows`
and renders a two-column side-by-side view, one `DiffRow` per table row:
`leftText` in the left column, `rightText` in the right column, either
side blank when its text is `null`. A row typed `"changed"` or
`"removed"` gets a `diff-removed` CSS class on its left cell (subtle
red-tinted background); `"changed"` or `"added"` gets `diff-added` on its
right cell (green-tinted); `"same"` rows are unstyled. Monospace font,
matching the editor's own font stack. This component has no knowledge of
commits, refs, or GitHub — it takes two strings and renders their diff,
making it equally
reusable for Phase 2's local-snapshot diffing.

### 3. Server: fetch a file's content at a specific ref

`src/github-repo.ts` gains `handleRepoFileAtRef`, following the same
raw-proxy pattern every other read endpoint in this file uses — this one
proxies GitHub's Contents API:

```ts
export async function handleRepoFileAtRef(request: Request, env: Env, owner: string, repo: string, path: string, ref: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

`src/worker.ts` gains a new route. Document repo paths can be nested
(confirmed via `repo-sync.ts`'s existing `repoPath.split("/").pop()`
usage elsewhere in this codebase), so — unlike every other repo route in
this file, which uses `[^/]+` per path segment — this route's path segment
must capture literal slashes:

```ts
const REPO_FILE_AT_REF_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/contents\/(.+)$/;
```

```ts
const repoFileAtRefMatch = url.pathname.match(REPO_FILE_AT_REF_PATH);
if (repoFileAtRefMatch && request.method === "GET") {
  const ref = url.searchParams.get("ref") || "";
  return handleRepoFileAtRef(request, env, repoFileAtRefMatch[1]!, repoFileAtRefMatch[2]!, repoFileAtRefMatch[3]!, ref);
}
```

Match order against the other repo routes doesn't matter — the
`/contents/` path prefix is disjoint from every other route's fixed
suffix (`/commits`, `/tree`, etc.), so `(.+)`'s greediness can't
misroute a request meant for one of those. Place the new constant
alongside the other `REPO_*_PATH` constants for readability, matching
existing file organization.

### 4. Client: `RepoInfoPanel.svelte` compare mode

Each commit row gains a checkbox. Selecting a checkbox adds that commit's
sha to a `selectedShas` array (capped at 2 — selecting a third
automatically deselects the oldest-selected one, keeping the interaction
simple rather than blocking with an error). Once exactly two are selected,
a "Compare" button appears above the list (in the same header area as the
repo link, following this app's established "primary action surfaces near
the top" pattern) and becomes clickable.

Clicking "Compare" needs the currently-open document's `repoPath` (via
`getActiveDoc()`, imported from `../stores/docs`, the same store
`RepoInfoPanel.svelte`'s sibling `DocInfoPanel.svelte` already uses for
the active doc). If the active doc has no `repoPath` (never synced to this
repo), the Compare button is disabled with a tooltip/title attribute
explaining why ("This document hasn't been synced to the repo yet").

On click, the panel fetches the doc's content at both selected shas via
the new endpoint (in parallel, `Promise.all`), decodes each response's
base64 `content` field the same inline way `repo-sync.ts` already does
elsewhere in this codebase (`atob(data.content.replace(/\n/g, ""))`), and
swaps the panel's body from the commit list into `DiffView.svelte` fed
with the two decoded strings (older-selected commit as `before`,
newer-selected as `after` — ordered by each commit's position in the
already-chronological list, not by selection order). A "Back to commits"
button returns to the list view, preserving `selectedShas` so the same
pair can be re-compared without reselecting.

## Non-goals (deferred)

- **Diffing two local Version History snapshots.** Phase 2's job, reusing
  `DiffView.svelte` built here.
- **Whole-repo compare view** (every file changed between two commits,
  GitHub-style). This phase stays scoped to the single currently-open
  document, per this session's own decomposition.
- **Files over GitHub's 1MB Contents API inline-content limit.** GitHub
  omits `content` for files above that size; this phase doesn't add
  special handling for the (for a single markdown document) rare case —
  the fetch will come back without decodable content, and the existing
  error-handling path (see below) surfaces it as a failed compare.
- **Selecting commits across a "Load more" boundary in a way that changes
  chronological ordering assumptions.** The before/after ordering logic
  relies on the commit list's existing chronological order, which holds
  regardless of how many pages have been loaded.

## Error handling

If either `handleRepoFileAtRef` call 404s (the document's file didn't
exist yet at that commit) or otherwise fails, the panel shows a toast
(`showToast(..., "error")`, this app's established pattern) — "Couldn't
load this document's content at one of the selected commits" — and stays
on the commit list rather than entering a broken diff view.

## Testing

- `src/github-repo.test.ts`: `handleRepoFileAtRef` returns 401 when signed
  out; constructs the correct upstream URL including proper per-segment
  encoding for a nested path; proxies a non-200 upstream response through
  unchanged (mirrors every other proxy endpoint's own tests).
- `client/src/diff-lines.test.ts`: `computeDiffRows` on identical strings
  returns all `"same"` rows with equal `leftText`/`rightText`; on a
  single replaced line returns one `"changed"` row pairing the old text
  on the left and new text on the right (not two separate rows), with
  unchanged rows around it marked `"same"`; on an added-only change
  (before is a prefix of after) returns only `"same"` rows plus `"added"`
  rows with `leftText: null`; on a removed-only change (after is a prefix
  of before) returns only `"same"` rows plus `"removed"` rows with
  `rightText: null`; on a replacement where the added block has more
  lines than the removed block, the surplus lines come back as `"added"`
  rows with `leftText: null` following the paired `"changed"` rows.
- No automated coverage for `DiffView.svelte` or `RepoInfoPanel.svelte`'s
  compare-mode interaction — matches this codebase's established
  precedent (no Svelte component tests). Manual verification: open Repo
  Info on a document with real sync history, select two commits, click
  Compare, confirm the diff renders correctly with removed lines on the
  left/added on the right and unchanged lines aligned across both
  columns; confirm "Back to commits" returns to the list with the same
  two checkboxes still selected; confirm selecting a third commit
  deselects the oldest; confirm the Compare button is disabled with an
  explanatory tooltip on a document that's never been synced to the repo.
