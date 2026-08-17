# Repo Commit History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace linked to a GitHub repo gets a place to see that repo's real commit history, fetched live from GitHub.

**Architecture:** A new server-side endpoint proxies GitHub's commits API unchanged (matching the existing `handleRepoList` pattern). A new client store + `window.MDE` bridge function opens a new `RepoInfoPanel.svelte`, modeled on `DocInfoPanel.svelte`'s overlay pattern, which fetches and paginates the commit list directly.

**Tech Stack:** TypeScript, Svelte 5, Cloudflare Workers, Vitest.

## Global Constraints

- `handleRepoCommits` proxies GitHub's raw JSON response unchanged — no reshaping, matching `handleRepoList`.
- Pagination is a fixed `per_page=30`, not client-configurable. "No more pages" is detected by a response returning fewer than 30 items — never parse GitHub's `Link` header.
- Opening the panel is gated behind the existing `requireRepoScope()` check (module-private in `repo-sync-ui.ts`) via a new `window.MDE.openRepoInfoPanel` bridge function — `MenuBar.svelte` must never import `repo-sync-ui.ts` directly, only `window.MDE` and stores.
- No automated coverage for `RepoInfoPanel.svelte` or the "Load more" flow — matches this codebase's established precedent (no Svelte component tests).

---

### Task 1: Server — list commits endpoint

**Files:**
- Modify: `src/github-repo.ts`
- Modify: `src/worker.ts`
- Test: `src/github-repo.test.ts`

**Interfaces:**
- Produces: `handleRepoCommits(request: Request, env: Env, owner: string, repo: string, branch: string, page: number): Promise<Response>` (exported from `src/github-repo.ts`).

- [ ] **Step 1: Write the failing tests**

In `src/github-repo.test.ts`, find:

```ts
import {
  handleRepoList,
  handleRepoCreate,
  handleRepoTree,
  handleRepoBlob,
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
  filterMarkdownEntries,
  handleRepoPush,
  computeNewTreeEntries,
} from "./github-repo";
```

Add this new `describe` block right after the existing `describe("handleRepoBlob", ...)` block (find its closing `});` — it's right before `describe("computeNewTreeEntries", ...)`):

```ts
describe("handleRepoCommits", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main");
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1);
    expect(res.status).toBe(401);
  });

  it("constructs the correct upstream URL with sha, page, and a fixed per_page=30", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/commits?sha=main&page=2&per_page=30");
        return new Response(JSON.stringify([{ sha: "abc123", commit: { message: "Fix bug", author: { name: "Alice", date: "2026-08-01T00:00:00Z" } } }]), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main&page=2", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 2);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sha: string }[];
    expect(data[0]!.sha).toBe("abc123");
  });

  it("proxies a non-200 upstream response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=missing-branch", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "missing-branch", 1);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/github-repo.test.ts`
Expected: FAIL — `handleRepoCommits` is not exported yet.

- [ ] **Step 3: Implement `handleRepoCommits`**

In `src/github-repo.ts`, find:

```ts
export async function handleRepoBlob(request: Request, env: Env, owner: string, repo: string, sha: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

Change to:

```ts
export async function handleRepoBlob(request: Request, env: Env, owner: string, repo: string, sha: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}

export async function handleRepoCommits(request: Request, env: Env, owner: string, repo: string, branch: string, page: number): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&page=${page}&per_page=30`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Wire the route**

In `src/worker.ts`, find:

```ts
import { handleRepoList, handleRepoCreate, handleRepoTree, handleRepoBlob, handleRepoPush } from "./github-repo.js";
```

Change to:

```ts
import { handleRepoList, handleRepoCreate, handleRepoTree, handleRepoBlob, handleRepoCommits, handleRepoPush } from "./github-repo.js";
```

Find:

```ts
const REPO_TREE_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/tree$/;
const REPO_BLOB_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]+)$/i;
const REPO_PUSH_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/push$/;
```

Change to:

```ts
const REPO_TREE_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/tree$/;
const REPO_BLOB_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]+)$/i;
const REPO_PUSH_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/push$/;
const REPO_COMMITS_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/commits$/;
```

Find:

```ts
    const repoBlobMatch = url.pathname.match(REPO_BLOB_PATH);
    if (repoBlobMatch && request.method === "GET") return handleRepoBlob(request, env, repoBlobMatch[1]!, repoBlobMatch[2]!, repoBlobMatch[3]!);

    const repoPushMatch = url.pathname.match(REPO_PUSH_PATH);
    if (repoPushMatch && request.method === "POST") return handleRepoPush(request, env, repoPushMatch[1]!, repoPushMatch[2]!);
```

Change to:

```ts
    const repoBlobMatch = url.pathname.match(REPO_BLOB_PATH);
    if (repoBlobMatch && request.method === "GET") return handleRepoBlob(request, env, repoBlobMatch[1]!, repoBlobMatch[2]!, repoBlobMatch[3]!);

    const repoCommitsMatch = url.pathname.match(REPO_COMMITS_PATH);
    if (repoCommitsMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      const page = Number(url.searchParams.get("page")) || 1;
      return handleRepoCommits(request, env, repoCommitsMatch[1]!, repoCommitsMatch[2]!, branch, page);
    }

    const repoPushMatch = url.pathname.match(REPO_PUSH_PATH);
    if (repoPushMatch && request.method === "POST") return handleRepoPush(request, env, repoPushMatch[1]!, repoPushMatch[2]!);
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
git commit -m "feat: add server endpoint to list a linked repo's commit history"
```

---

### Task 2: Client — store, bridge function, and type declaration

**Files:**
- Create: `client/src/stores/repoInfoPanel.ts`
- Modify: `client/src/repo-sync-ui.ts`
- Modify: `client/src/types.ts`

**Interfaces:**
- Consumes: `handleRepoCommits`'s route from Task 1 (`GET /api/repo/:owner/:repo/commits?branch=X&page=N`), `requireRepoScope()` (already exists, module-private in `repo-sync-ui.ts`).
- Produces: `repoInfoPanelOpen` (exported `writable<boolean>` from `client/src/stores/repoInfoPanel.ts`), `window.MDE.openRepoInfoPanel(): void` (set in `repo-sync-ui.ts`, declared in `MDEBridge`).

- [ ] **Step 1: Create the store**

Create `client/src/stores/repoInfoPanel.ts`:

```ts
import { writable } from "svelte/store";

export const repoInfoPanelOpen = writable(false);
```

- [ ] **Step 2: Add the `MDEBridge` type declaration**

In `client/src/types.ts`, find:

```ts
  // Set by repo-sync-ui.ts at module load, same pattern as the two above.
  openRepoLinkModal?(): void;
  openRepoModal?(): void;
  pushToRepoAction?(): void;
  pullFromRepoAction?(): void;
  unlinkRepo?(): void;
}
```

Change to:

```ts
  // Set by repo-sync-ui.ts at module load, same pattern as the two above.
  openRepoLinkModal?(): void;
  openRepoModal?(): void;
  openRepoInfoPanel?(): void;
  pushToRepoAction?(): void;
  pullFromRepoAction?(): void;
  unlinkRepo?(): void;
}
```

- [ ] **Step 3: Add the bridge function**

In `client/src/repo-sync-ui.ts`, find:

```ts
import { activeWorkspaceIdStore, workspacesStore, clearWorkspaceRepoLink } from "./stores/workspaces";
import { docsInWorkspace } from "./stores/docs";
import { pullFromRepo, pushToRepo, type PullConflict, type PushConflict } from "./repo-sync";
import { repoLinkModalOpen, openRepoModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast, showToast } from "./stores/toast";
import { get } from "svelte/store";
```

Change to:

```ts
import { activeWorkspaceIdStore, workspacesStore, clearWorkspaceRepoLink } from "./stores/workspaces";
import { docsInWorkspace } from "./stores/docs";
import { pullFromRepo, pushToRepo, type PullConflict, type PushConflict } from "./repo-sync";
import { repoLinkModalOpen, openRepoModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
import { repoInfoPanelOpen } from "./stores/repoInfoPanel";
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast, showToast } from "./stores/toast";
import { get } from "svelte/store";
```

Find:

```ts
window.MDE.openRepoLinkModal = () => {
  void (async () => {
    if (get(workspacesStore).length === 0) {
      showToast("Create a workspace first", "error");
      return;
    }
    if (!(await requireRepoScope())) return;
    repoLinkModalOpen.set(true);
  })();
};
```

Change to:

```ts
window.MDE.openRepoLinkModal = () => {
  void (async () => {
    if (get(workspacesStore).length === 0) {
      showToast("Create a workspace first", "error");
      return;
    }
    if (!(await requireRepoScope())) return;
    repoLinkModalOpen.set(true);
  })();
};

window.MDE.openRepoInfoPanel = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    repoInfoPanelOpen.set(true);
  })();
};
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no test coverage touches these new lines directly — they're DOM/window-bridge wiring, matching this codebase's established precedent).

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/repoInfoPanel.ts client/src/repo-sync-ui.ts client/src/types.ts
git commit -m "feat: add window.MDE.openRepoInfoPanel bridge and store"
```

---

### Task 3: `RepoInfoPanel.svelte` and its menu entry

**Files:**
- Create: `client/src/components/RepoInfoPanel.svelte`
- Modify: `client/index.html`
- Modify: `client/src/main.ts`
- Modify: `client/src/components/MenuBar.svelte`

**Interfaces:**
- Consumes: `repoInfoPanelOpen` (from Task 2, `../stores/repoInfoPanel`), `activeWorkspaceIdStore`/`workspacesStore` (already exist, `../stores/workspaces`), `window.MDE.formatRelativeTime` (already exists), `window.MDE.openRepoInfoPanel` (from Task 2).
- Produces: nothing new consumed by later tasks — this is the last task before final verification.

- [ ] **Step 1: Create the component**

Create `client/src/components/RepoInfoPanel.svelte`:

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

  async function loadPage(targetPage: number): Promise<CommitEntry[] | null> {
    if (!repoLink) return null;
    const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/commits?branch=${encodeURIComponent(repoLink.branch)}&page=${targetPage}`);
    if (!res.ok) {
      showToast("Couldn't load commit history", "error");
      return null;
    }
    return (await res.json()) as CommitEntry[];
  }

  async function loadFirstPage() {
    if (!repoLink) return;
    loading = true;
    page = 1;
    const result = await loadPage(1);
    commits = result ?? [];
    hasMore = (result?.length ?? 0) === 30;
    loading = false;
  }

  async function loadMore() {
    loadingMore = true;
    const nextPage = page + 1;
    const result = await loadPage(nextPage);
    if (result) {
      commits = [...commits, ...result];
      page = nextPage;
      hasMore = result.length === 30;
    }
    loadingMore = false;
  }

  function close() {
    repoInfoPanelOpen.set(false);
  }

  $effect(() => {
    if ($repoInfoPanelOpen) void loadFirstPage();
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $repoInfoPanelOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

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

- [ ] **Step 2: Mount it**

In `client/index.html`, find:

```html
<!-- Document Info panel — Svelte component, mounted in main.ts; see
     client/src/components/DocInfoPanel.svelte -->
<div id="doc-info-panel-mount"></div>
```

Change to:

```html
<!-- Document Info panel — Svelte component, mounted in main.ts; see
     client/src/components/DocInfoPanel.svelte -->
<div id="doc-info-panel-mount"></div>

<!-- Repo Info panel — Svelte component, mounted in main.ts; see
     client/src/components/RepoInfoPanel.svelte -->
<div id="repo-info-panel-mount"></div>
```

In `client/src/main.ts`, find:

```ts
import DocInfoPanel from "./components/DocInfoPanel.svelte";
```

Change to:

```ts
import DocInfoPanel from "./components/DocInfoPanel.svelte";
import RepoInfoPanel from "./components/RepoInfoPanel.svelte";
```

Find:

```ts
mount(DocInfoPanel, { target: document.getElementById("doc-info-panel-mount")! });
```

Change to:

```ts
mount(DocInfoPanel, { target: document.getElementById("doc-info-panel-mount")! });
mount(RepoInfoPanel, { target: document.getElementById("repo-info-panel-mount")! });
```

- [ ] **Step 3: Add the menu entry**

In `client/src/components/MenuBar.svelte`, find:

```svelte
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pushToRepoAction?.())}>
              <svg class="icon"><use href="#icon-upload"></use></svg> {$repoSyncBusyLabel === "Pushing…" ? "Pushing…" : "Push to Repo"}
            </button>
            <button type="button" onclick={() => act(() => window.MDE.unlinkRepo?.())}>
              <svg class="icon"><use href="#icon-x"></use></svg> Unlink Repo
            </button>
```

Change to:

```svelte
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pushToRepoAction?.())}>
              <svg class="icon"><use href="#icon-upload"></use></svg> {$repoSyncBusyLabel === "Pushing…" ? "Pushing…" : "Push to Repo"}
            </button>
            <button type="button" onclick={() => act(() => window.MDE.openRepoInfoPanel?.())}>
              <svg class="icon"><use href="#icon-info"></use></svg> Repo info
            </button>
            <button type="button" onclick={() => act(() => window.MDE.unlinkRepo?.())}>
              <svg class="icon"><use href="#icon-x"></use></svg> Unlink Repo
            </button>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Manual verification**

With the `npm run dev` full stack (Worker + GitHub OAuth), link a workspace to a repo with real commit history, open File > GitHub Repo > Repo info, and confirm:
- The repo link (owner/repo/branch) shows at the top and links out to GitHub correctly.
- The commit list loads with correct messages (first line only), author names, and relative dates, each linking to that commit on GitHub.
- "Load more" appends further commits and disappears once history is exhausted (test against a repo with fewer than 30 commits total, so the very first page already comes back short and the button never appears).
- A session without repo scope gets the existing "sign in for repo access" prompt instead of the panel opening.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/RepoInfoPanel.svelte client/index.html client/src/main.ts client/src/components/MenuBar.svelte
git commit -m "feat: add a repo info panel showing the linked repo's commit history"
```

---

### Task 4: Final verification

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

Covered by Task 3's Step 6 — this needs the full `npm run dev` stack with real GitHub OAuth and a real linked repo with commit history. If you can't run the full authenticated stack, flag this to the user rather than attempting it blind, same as the manual-verification notes on prior plans this session.
