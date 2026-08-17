# Repo Commit Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the Repo Info panel, a user can pick any two commits and see a side-by-side diff of how the currently-open document's content differs between them.

**Architecture:** A new `diff` npm dependency plus a thin wrapper module (`client/src/diff-lines.ts`) compute paired diff rows; a new shared, commit-agnostic `DiffView.svelte` renders them; a new server endpoint proxies GitHub's Contents API to fetch a file's content at a given ref; `RepoInfoPanel.svelte` gains commit-selection checkboxes and a Compare button that fetches both versions and swaps into the diff view.

**Tech Stack:** TypeScript, Svelte 5, Cloudflare Workers, Vitest, the `diff` npm package (Myers line-diff).

## Global Constraints

- The `diff` npm package (Myers line-diff algorithm) is the diff engine — no hand-rolled algorithm, no `@codemirror/merge`.
- A replaced line's old and new text share one row (`"changed"` type) rather than appearing as two separate remove/add rows — this is what the user approved in the design mockup.
- `DiffView.svelte` has no knowledge of commits, refs, or GitHub — it takes two strings and renders their diff, so it's reusable for Phase 2 (local Version History diffing).
- Document repo paths can contain slashes (nested directories) — the new server route's path segment must capture literal slashes, unlike every other repo route's `[^/]+` segments.
- No automated coverage for `DiffView.svelte` or `RepoInfoPanel.svelte`'s compare-mode interaction — matches this codebase's established precedent (no Svelte component tests).

---

### Task 1: Diff computation — `client/src/diff-lines.ts`

**Files:**
- Modify: `package.json` (add `diff` dependency)
- Create: `client/src/diff-lines.ts`
- Test: `client/src/diff-lines.test.ts`

**Interfaces:**
- Produces: `DiffRow` interface (`leftText: string | null`, `rightText: string | null`, `type: "same" | "changed" | "removed" | "added"`) and `computeDiffRows(before: string, after: string): DiffRow[]`, both exported from `client/src/diff-lines.ts`. Task 3 (`DiffView.svelte`) consumes both.

- [ ] **Step 1: Add the `diff` dependency**

Run: `npm install diff@^9.0.0`

This adds `diff` to `package.json`'s `dependencies` and updates `package-lock.json`. The package ships its own TypeScript types (`libcjs/index.d.ts`), so no `@types/diff` is needed.

- [ ] **Step 2: Write the failing tests**

Create `client/src/diff-lines.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeDiffRows } from "./diff-lines";

describe("computeDiffRows", () => {
  it("returns all same rows for identical strings", () => {
    const rows = computeDiffRows("line1\nline2\n", "line1\nline2\n");
    expect(rows).toEqual([
      { leftText: "line1", rightText: "line1", type: "same" },
      { leftText: "line2", rightText: "line2", type: "same" },
    ]);
  });

  it("pairs a single replaced line onto one changed row", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "old", rightText: "new", type: "changed" },
      { leftText: "b", rightText: "b", type: "same" },
    ]);
  });

  it("returns only same and added rows for an added-only change", () => {
    const rows = computeDiffRows("a\nb\n", "a\nb\nc\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "b", rightText: "b", type: "same" },
      { leftText: null, rightText: "c", type: "added" },
    ]);
  });

  it("returns only same and removed rows for a removed-only change", () => {
    const rows = computeDiffRows("a\nb\nc\n", "a\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "b", rightText: "b", type: "same" },
      { leftText: "c", rightText: null, type: "removed" },
    ]);
  });

  it("pairs matching lines and puts surplus added lines on their own rows", () => {
    const rows = computeDiffRows("a\nold\nb\n", "a\nnew1\nnew2\nb\n");
    expect(rows).toEqual([
      { leftText: "a", rightText: "a", type: "same" },
      { leftText: "old", rightText: "new1", type: "changed" },
      { leftText: null, rightText: "new2", type: "added" },
      { leftText: "b", rightText: "b", type: "same" },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: FAIL — `client/src/diff-lines.ts` doesn't exist yet.

- [ ] **Step 4: Implement `diff-lines.ts`**

Create `client/src/diff-lines.ts`:

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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run client/src/diff-lines.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json client/src/diff-lines.ts client/src/diff-lines.test.ts
git commit -m "feat: add diff computation for comparing two text versions"
```

---

### Task 2: Server — fetch a file's content at a specific ref

**Files:**
- Modify: `src/github-repo.ts`
- Modify: `src/worker.ts`
- Test: `src/github-repo.test.ts`

**Interfaces:**
- Produces: `handleRepoFileAtRef(request: Request, env: Env, owner: string, repo: string, path: string, ref: string): Promise<Response>` (exported from `src/github-repo.ts`).

- [ ] **Step 1: Write the failing tests**

In `src/github-repo.test.ts`, find:

```ts
import {
  handleRepoList,
  handleRepoCreate,
  handleRepoTree,
  handleRepoBlob,
  handleRepoCommits,
  filterMarkdownEntries,
  handleRepoPush,
  computeNewTreeEntries,
} from "./github-repo";
```

Change to:

```ts
import {
  handleRepoList,
  handleRepoCreate,
  handleRepoTree,
  handleRepoBlob,
  handleRepoCommits,
  handleRepoFileAtRef,
  filterMarkdownEntries,
  handleRepoPush,
  computeNewTreeEntries,
} from "./github-repo";
```

Find the end of the `describe("handleRepoCommits", ...)` block — its closing `});` is immediately followed by `describe("computeNewTreeEntries", ...)`. Insert a new block between them:

```ts
describe("handleRepoFileAtRef", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/contents/Notes.md?ref=main");
    const res = await handleRepoFileAtRef(req, fakeEnv, "alice", "notes", "Notes.md", "main");
    expect(res.status).toBe(401);
  });

  it("constructs the correct upstream URL with per-segment encoding for a nested path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/contents/folder%20a/My%20Notes.md?ref=abc123");
        return new Response(JSON.stringify({ content: "aGVsbG8=", encoding: "base64" }), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/contents/folder%20a/My%20Notes.md?ref=abc123", { headers: { Cookie: cookie } });
    const res = await handleRepoFileAtRef(req, fakeEnv, "alice", "notes", "folder a/My Notes.md", "abc123");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { content: string };
    expect(data.content).toBe("aGVsbG8=");
  });

  it("proxies a non-200 upstream response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/contents/Missing.md?ref=main", { headers: { Cookie: cookie } });
    const res = await handleRepoFileAtRef(req, fakeEnv, "alice", "notes", "Missing.md", "main");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/github-repo.test.ts`
Expected: FAIL — `handleRepoFileAtRef` is not exported yet.

- [ ] **Step 3: Implement `handleRepoFileAtRef`**

In `src/github-repo.ts`, find:

```ts
export async function handleRepoCommits(request: Request, env: Env, owner: string, repo: string, branch: string, page: number): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&page=${page}&per_page=30`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

Change to:

```ts
export async function handleRepoCommits(request: Request, env: Env, owner: string, repo: string, branch: string, page: number): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&page=${page}&per_page=30`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}

export async function handleRepoFileAtRef(request: Request, env: Env, owner: string, repo: string, path: string, ref: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Wire the route**

In `src/worker.ts`, find:

```ts
import { handleRepoList, handleRepoCreate, handleRepoTree, handleRepoBlob, handleRepoCommits, handleRepoPush } from "./github-repo.js";
```

Change to:

```ts
import { handleRepoList, handleRepoCreate, handleRepoTree, handleRepoBlob, handleRepoCommits, handleRepoFileAtRef, handleRepoPush } from "./github-repo.js";
```

Find:

```ts
const REPO_COMMITS_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/commits$/;
```

Change to:

```ts
const REPO_COMMITS_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/commits$/;
const REPO_FILE_AT_REF_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/contents\/(.+)$/;
```

Find:

```ts
    const repoCommitsMatch = url.pathname.match(REPO_COMMITS_PATH);
    if (repoCommitsMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      const page = Number(url.searchParams.get("page")) || 1;
      return handleRepoCommits(request, env, repoCommitsMatch[1]!, repoCommitsMatch[2]!, branch, page);
    }
```

Change to:

```ts
    const repoCommitsMatch = url.pathname.match(REPO_COMMITS_PATH);
    if (repoCommitsMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      const page = Number(url.searchParams.get("page")) || 1;
      return handleRepoCommits(request, env, repoCommitsMatch[1]!, repoCommitsMatch[2]!, branch, page);
    }

    const repoFileAtRefMatch = url.pathname.match(REPO_FILE_AT_REF_PATH);
    if (repoFileAtRefMatch && request.method === "GET") {
      const ref = url.searchParams.get("ref") || "";
      return handleRepoFileAtRef(request, env, repoFileAtRefMatch[1]!, repoFileAtRefMatch[2]!, repoFileAtRefMatch[3]!, ref);
    }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/github-repo.ts src/worker.ts src/github-repo.test.ts
git commit -m "feat: add server endpoint to fetch a repo file's content at a specific commit"
```

---

### Task 3: `DiffView.svelte`

**Files:**
- Create: `client/src/components/DiffView.svelte`
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `DiffRow`, `computeDiffRows` from Task 1 (`../diff-lines`).
- Produces: `DiffView.svelte`, a component with props `{ before: string; after: string }`, consumed by Task 4.

- [ ] **Step 1: Create the component**

Create `client/src/components/DiffView.svelte`:

```svelte
<script lang="ts">
  import { computeDiffRows } from "../diff-lines";

  interface Props {
    before: string;
    after: string;
  }
  const { before, after }: Props = $props();

  const rows = $derived(computeDiffRows(before, after));
</script>

<div class="diff-view">
  {#each rows as row, i (i)}
    <div class="diff-view-row">
      <div class="diff-view-cell" class:diff-removed={row.type === "changed" || row.type === "removed"}>{row.leftText ?? ""}</div>
      <div class="diff-view-cell" class:diff-added={row.type === "changed" || row.type === "added"}>{row.rightText ?? ""}</div>
    </div>
  {/each}
</div>
```

- [ ] **Step 2: Add CSS**

In `client/src/style.css`, find:

```css
.doc-info-link { text-decoration: none; }
.doc-info-link:hover, .doc-info-link:focus-visible { color: var(--accent); text-decoration: underline; }
```

Change to:

```css
.doc-info-link { text-decoration: none; }
.doc-info-link:hover, .doc-info-link:focus-visible { color: var(--accent); text-decoration: underline; }

.diff-view { font-family: var(--mono); font-size: 12.5px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.diff-view-row { display: grid; grid-template-columns: 1fr 1fr; }
.diff-view-cell { padding: 2px 8px; white-space: pre-wrap; word-break: break-word; border-bottom: 1px solid var(--border); }
.diff-view-cell:first-child { border-right: 1px solid var(--border); }
.diff-view-row:last-child .diff-view-cell { border-bottom: none; }
.diff-view-cell.diff-removed { background: rgba(220, 38, 38, 0.12); }
.diff-view-cell.diff-added { background: rgba(34, 197, 94, 0.14); }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no automated coverage of the component itself, per this codebase's precedent).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DiffView.svelte client/src/style.css
git commit -m "feat: add a shared side-by-side diff view component"
```

---

### Task 4: `RepoInfoPanel.svelte` compare mode

**Files:**
- Modify: `client/src/components/RepoInfoPanel.svelte`
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `DiffView.svelte` from Task 3 (`./DiffView.svelte`), `handleRepoFileAtRef`'s route from Task 2 (`GET /api/repo/:owner/:repo/contents/:path?ref=X`), `getActiveDoc`, `activeIdStore` (already exist, `../stores/docs`).
- Produces: nothing new consumed by later tasks — this is the last feature task before final verification.

- [ ] **Step 1: Add imports and state**

In `client/src/components/RepoInfoPanel.svelte`, find:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { repoInfoPanelOpen } from "../stores/repoInfoPanel";
  import { activeWorkspaceIdStore, workspacesStore } from "../stores/workspaces";
  import { showToast } from "../stores/toast";

  interface CommitEntry {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    html_url: string;
  }

  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const repoLink = $derived(activeWorkspace?.repoLink);

  let commits = $state<CommitEntry[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let page = $state(1);

  function firstLine(message: string): string {
    return message.split("\n")[0] || message;
  }
```

Change to:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import DiffView from "./DiffView.svelte";
  import { repoInfoPanelOpen } from "../stores/repoInfoPanel";
  import { activeWorkspaceIdStore, workspacesStore } from "../stores/workspaces";
  import { activeIdStore, getActiveDoc } from "../stores/docs";
  import { showToast } from "../stores/toast";

  interface CommitEntry {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    html_url: string;
  }

  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const repoLink = $derived(activeWorkspace?.repoLink);
  const activeDoc = $derived($activeIdStore ? getActiveDoc() : undefined);

  let commits = $state<CommitEntry[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let page = $state(1);

  let viewMode = $state<"list" | "diff">("list");
  let selectedShas = $state<string[]>([]);
  let comparing = $state(false);
  let diffBefore = $state("");
  let diffAfter = $state("");

  const compareDisabledReason = $derived(
    !activeDoc?.repoPath ? "This document hasn't been synced to the repo yet" : selectedShas.length !== 2 ? "Select two commits to compare" : undefined
  );

  function firstLine(message: string): string {
    return message.split("\n")[0] || message;
  }

  function commitIndex(sha: string): number {
    return commits.findIndex((c) => c.sha === sha);
  }

  function toggleSelect(sha: string) {
    if (selectedShas.includes(sha)) {
      selectedShas = selectedShas.filter((s) => s !== sha);
    } else if (selectedShas.length >= 2) {
      selectedShas = [selectedShas[1]!, sha];
    } else {
      selectedShas = [...selectedShas, sha];
    }
  }

  async function fetchFileAtRef(ref: string): Promise<string | null> {
    if (!repoLink || !activeDoc?.repoPath) return null;
    const encodedPath = activeDoc.repoPath
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { content: string; encoding: string };
    if (data.encoding !== "base64") return data.content;
    return atob(data.content.replace(/\n/g, ""));
  }

  async function compare() {
    if (compareDisabledReason || comparing) return;
    const sorted = [...selectedShas].sort((a, b) => commitIndex(b) - commitIndex(a));
    const [olderSha, newerSha] = sorted;
    comparing = true;
    const [before, after] = await Promise.all([fetchFileAtRef(olderSha!), fetchFileAtRef(newerSha!)]);
    comparing = false;
    if (before === null || after === null) {
      showToast("Couldn't load this document's content at one of the selected commits", "error");
      return;
    }
    diffBefore = before;
    diffAfter = after;
    viewMode = "diff";
  }

  function backToList() {
    viewMode = "list";
  }
```

- [ ] **Step 2: Reset compare state when the panel opens**

In `client/src/components/RepoInfoPanel.svelte`, find:

```ts
  async function loadFirstPage() {
    if (!repoLink) return;
    loading = true;
    page = 1;
    const result = await loadPage(1);
    commits = result ?? [];
    hasMore = (result?.length ?? 0) === 30;
    loading = false;
  }
```

Change to:

```ts
  async function loadFirstPage() {
    if (!repoLink) return;
    viewMode = "list";
    selectedShas = [];
    loading = true;
    page = 1;
    const result = await loadPage(1);
    commits = result ?? [];
    hasMore = (result?.length ?? 0) === 30;
    loading = false;
  }
```

- [ ] **Step 3: Update the template**

Find:

```svelte
{#if $repoInfoPanelOpen && repoLink}
  <Modal title="Repo info" icon="icon-github" labelledBy="repoInfoTitle" onClose={close}>
    <div class="doc-info-row">
      <span class="doc-info-primary">Repo</span>
      <a class="doc-info-secondary doc-info-link" href={`https://github.com/${repoLink.owner}/${repoLink.repo}/tree/${repoLink.branch}`} target="_blank" rel="noopener">
        {repoLink.owner}/{repoLink.repo} ({repoLink.branch})
      </a>
    </div>
    <div class="menu-section-label">Commits</div>
    {#if loading}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
        <div class="empty-state-title">Loading…</div>
      </div>
    {:else if commits.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-github"></use></svg>
        <div class="empty-state-title">No commits found</div>
      </div>
    {:else}
      <div class="doc-info-backlinks">
        {#each commits as c (c.sha)}
          <a class="doc-info-backlink-row" href={c.html_url} target="_blank" rel="noopener">
            <span>{firstLine(c.commit.message)}</span>
            <span class="doc-info-secondary">{c.commit.author.name} • {window.MDE.formatRelativeTime(new Date(c.commit.author.date).getTime())}</span>
          </a>
        {/each}
      </div>
      {#if hasMore}
        <button type="button" class="secondary-btn" disabled={loadingMore} onclick={loadMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      {/if}
    {/if}
  </Modal>
{/if}
```

Change to:

```svelte
{#if $repoInfoPanelOpen && repoLink}
  <Modal title="Repo info" icon="icon-github" labelledBy="repoInfoTitle" onClose={close}>
    <div class="doc-info-row">
      <span class="doc-info-primary">Repo</span>
      <a class="doc-info-secondary doc-info-link" href={`https://github.com/${repoLink.owner}/${repoLink.repo}/tree/${repoLink.branch}`} target="_blank" rel="noopener">
        {repoLink.owner}/{repoLink.repo} ({repoLink.branch})
      </a>
    </div>
    {#if viewMode === "diff"}
      <div class="repo-commit-compare-bar">
        <button type="button" class="secondary-btn" onclick={backToList}>
          <svg class="icon"><use href="#icon-chevron-left"></use></svg> Back to commits
        </button>
      </div>
      <DiffView before={diffBefore} after={diffAfter} />
    {:else}
      <div class="repo-commit-compare-bar">
        <button type="button" class="secondary-btn" disabled={!!compareDisabledReason || comparing} title={compareDisabledReason} onclick={compare}>
          {comparing ? "Comparing…" : "Compare"}
        </button>
      </div>
      <div class="menu-section-label">Commits</div>
      {#if loading}
        <div class="empty-state">
          <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
          <div class="empty-state-title">Loading…</div>
        </div>
      {:else if commits.length === 0}
        <div class="empty-state">
          <svg class="empty-state-icon"><use href="#icon-github"></use></svg>
          <div class="empty-state-title">No commits found</div>
        </div>
      {:else}
        <div class="doc-info-backlinks">
          {#each commits as c (c.sha)}
            <div class="repo-commit-row">
              <input type="checkbox" checked={selectedShas.includes(c.sha)} onchange={() => toggleSelect(c.sha)} aria-label={`Select commit: ${firstLine(c.commit.message)}`} />
              <a class="repo-commit-link" href={c.html_url} target="_blank" rel="noopener">
                <span>{firstLine(c.commit.message)}</span>
                <span class="doc-info-secondary">{c.commit.author.name} • {window.MDE.formatRelativeTime(new Date(c.commit.author.date).getTime())}</span>
              </a>
            </div>
          {/each}
        </div>
        {#if hasMore}
          <button type="button" class="secondary-btn" disabled={loadingMore} onclick={loadMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        {/if}
      {/if}
    {/if}
  </Modal>
{/if}
```

- [ ] **Step 4: Add CSS for the new commit-row shape and compare bar**

In `client/src/style.css`, find:

```css
.doc-info-backlinks { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.doc-info-backlink-row { text-align: left; border: none; background: var(--bg-alt); border-radius: 6px; padding: 6px 10px; cursor: pointer; font-family: inherit; font-size: 13px; }
.doc-info-backlink-row:hover { background: var(--border); }
```

Change to:

```css
.doc-info-backlinks { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.doc-info-backlink-row { text-align: left; border: none; background: var(--bg-alt); border-radius: 6px; padding: 6px 10px; cursor: pointer; font-family: inherit; font-size: 13px; }
.doc-info-backlink-row:hover { background: var(--border); }

.repo-commit-row { display: flex; align-items: center; gap: 10px; background: var(--bg-alt); border-radius: 6px; padding: 6px 10px; }
.repo-commit-row input[type="checkbox"] { flex-shrink: 0; cursor: pointer; }
.repo-commit-link { flex: 1; min-width: 0; display: flex; flex-direction: column; text-decoration: none; font-size: 13px; color: inherit; }
.repo-commit-link:hover { text-decoration: underline; }
.repo-commit-compare-bar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.repo-commit-compare-bar .secondary-btn { width: auto; margin-bottom: 0; }
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Manual verification**

With the `npm run dev` full stack (Worker + GitHub OAuth), link a workspace to a repo with real commit history for a synced document, open File > GitHub Repo > Repo info, and confirm:
- Each commit row shows a checkbox alongside its existing link.
- Selecting a first and second commit enables the "Compare" button; selecting a third automatically deselects the first-selected one, keeping exactly two checked.
- Clicking "Compare" swaps the panel into a side-by-side diff: removed/changed text in the left column has a red-tinted background, added/changed text in the right column has a green-tinted background, and a single-line replacement shows the old and new text on the same row (not two separate rows).
- "Back to commits" returns to the commit list with the same two commits still checked.
- On a document that has never been synced to the repo (no `repoPath`), the "Compare" button is disabled with a title tooltip explaining why, regardless of selection.
- Closing and reopening the panel resets back to the commit list (not a stale diff view) and clears the selection.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/RepoInfoPanel.svelte client/src/style.css
git commit -m "feat: add commit selection and diff compare mode to the repo info panel"
```

---

### Task 5: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated).

- [ ] **Step 4: Manual verification**

Covered by Task 4's Step 7 — this needs the full `npm run dev` stack with real GitHub OAuth and a real linked repo with a synced document that has commit history. If you can't run the full authenticated stack, flag this to the user rather than attempting it blind, same as the manual-verification notes on prior plans this session.
