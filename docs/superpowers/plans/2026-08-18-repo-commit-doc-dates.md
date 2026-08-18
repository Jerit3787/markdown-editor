# Repo Commit Doc Dates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Document Info panel, show a repo-linked document's real "Created" and "Edited" dates from its GitHub commit history instead of local-only timestamps.

**Architecture:** A new pure client module (`client/src/repo-doc-dates.ts`) fetches a file's commit history via the existing `/api/repo/{owner}/{repo}/commits` endpoint, using GitHub's `Link` pagination header to reach the oldest commit in at most 2 requests. The worker's `proxyJson` helper (`src/github-repo.ts`) is extended to forward that header, which it currently drops. `DocInfoPanel.svelte` calls the new module reactively and swaps the displayed dates in place when it resolves, falling back to local timestamps on any failure.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest, Cloudflare Workers.

## Global Constraints

- Display-only: `doc.createdAt` / `doc.updatedAt` are never written to. No schema change, no persistence of repo-derived dates.
- Scoped to `DocInfoPanel.svelte` only — sidebar doc list, "Open Recent" menu, and Command Palette are untouched.
- Applies only when `doc.repoPath` is set and the doc's workspace has a `repoLink`. All other docs render exactly as today.
- Use `commit.author.date` (not `committer.date`) — matches the field `VersionHistory.svelte:90` already uses, for consistency.
- Silent fallback to local timestamps on any failure (network error, empty commit history, non-repo doc). Never show an error state for this.
- This codebase has no Svelte component test infra (0 `.svelte` files have `.test.ts` counterparts — every existing test file covers a plain `.ts` logic module). Keep all fetch/parsing logic in the new `.ts` module so it's fully unit-testable; `DocInfoPanel.svelte`'s changes are thin glue verified live in a browser, matching how `VersionHistory.svelte`'s existing fetch logic is untested.

---

### Task 1: Forward the `Link` response header through `proxyJson`

**Files:**
- Modify: `src/github-repo.ts:55-57` (the `proxyJson` function)
- Test: `src/github-repo.test.ts` (add to the existing `describe("handleRepoCommits", ...)` block, which starts at line 168)

**Interfaces:**
- Produces: `proxyJson` (unchanged signature — `(res: Response) => Promise<Response>`) now forwards a `Link` header from `res` onto the returned `Response` when present. Every existing caller (`handleRepoList`, `handleRepoCreate`, `handleRepoTree`, `handleRepoBlob`, `handleRepoCommits`, `handleRepoFileAtRef`) is unaffected when GitHub's response has no `Link` header.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("handleRepoCommits", ...)` block in `src/github-repo.test.ts` (after the last existing test in that block, before its closing `});` at line 226):

```ts
  it("forwards GitHub's Link pagination header to the client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([{ sha: "abc123", commit: { message: "Fix bug", author: { name: "Alice", date: "2026-08-01T00:00:00Z" } } }]), {
          status: 200,
          headers: { Link: '<https://api.github.com/repositories/1/commits?page=2>; rel="next", <https://api.github.com/repositories/1/commits?page=5>; rel="last"' },
        })
      )
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1);
    expect(res.status).toBe(200);
    expect(res.headers.get("Link")).toBe(
      '<https://api.github.com/repositories/1/commits?page=2>; rel="next", <https://api.github.com/repositories/1/commits?page=5>; rel="last"'
    );
  });

  it("omits the Link header when GitHub's response doesn't have one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1);
    expect(res.headers.get("Link")).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- github-repo.test.ts`
Expected: FAIL — the first new test fails because `res.headers.get("Link")` is `null` (the current `proxyJson` never sets it).

- [ ] **Step 3: Update `proxyJson` to forward the `Link` header**

In `src/github-repo.ts`, replace the current `proxyJson` function (lines 55-57):

```ts
async function proxyJson(res: Response): Promise<Response> {
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}
```

with:

```ts
async function proxyJson(res: Response): Promise<Response> {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  const link = res.headers.get("Link");
  if (link) headers["Link"] = link;
  return new Response(res.body, { status: res.status, headers });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- github-repo.test.ts`
Expected: PASS — all tests in `github-repo.test.ts`, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/github-repo.ts src/github-repo.test.ts
git commit -m "feat: forward GitHub's Link pagination header through proxyJson"
```

---

### Task 2: `repo-doc-dates.ts` — fetch a file's created/modified dates from commit history

**Files:**
- Create: `client/src/repo-doc-dates.ts`
- Test: `client/src/repo-doc-dates.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly at the type level — relies on the now-forwarded `Link` header being present on responses from `/api/repo/{owner}/{repo}/commits`, which Task 1 makes true in production. Tests in this task mock `fetch` directly and don't depend on Task 1's code.
- Produces:
  ```ts
  export interface RepoDocDates {
    createdAt: number;
    updatedAt: number;
  }

  export async function fetchRepoDocDates(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    signal?: AbortSignal
  ): Promise<RepoDocDates | undefined>
  ```
  Task 3 imports `fetchRepoDocDates` and `RepoDocDates` from this file.

- [ ] **Step 1: Write the failing tests**

Create `client/src/repo-doc-dates.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRepoDocDates } from "./repo-doc-dates";

afterEach(() => {
  vi.unstubAllGlobals();
});

function commitsResponse(dates: string[], link?: string) {
  const body = dates.map((date, i) => ({
    sha: `sha-${i}`,
    commit: { message: `commit ${i}`, author: { name: "Alice", date } },
  }));
  const headers: HeadersInit = {};
  if (link) headers["Link"] = link;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("fetchRepoDocDates", () => {
  it("uses the newest commit as updatedAt and the oldest as createdAt when history fits on one page", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        // Newest first, matching GitHub's actual ordering.
        return commitsResponse(["2026-08-10T00:00:00Z", "2026-08-05T00:00:00Z", "2026-01-01T00:00:00Z"]);
      })
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toEqual({
      updatedAt: new Date("2026-08-10T00:00:00Z").getTime(),
      createdAt: new Date("2026-01-01T00:00:00Z").getTime(),
    });
    expect(calls).toHaveLength(1);
  });

  it("fetches the last page (via the Link header) to find createdAt when history spans multiple pages", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("page=1")) {
          return commitsResponse(
            ["2026-08-10T00:00:00Z", "2026-08-05T00:00:00Z"],
            '<https://api.github.com/repositories/1/commits?page=2>; rel="next", <https://api.github.com/repositories/1/commits?page=3>; rel="last"'
          );
        }
        if (url.includes("page=3")) {
          return commitsResponse(["2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toEqual({
      updatedAt: new Date("2026-08-10T00:00:00Z").getTime(),
      createdAt: new Date("2026-01-01T00:00:00Z").getTime(),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("page=3");
  });

  it("returns undefined when the file has no commits yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => commitsResponse([])));
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toBeUndefined();
  });

  it("returns undefined when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Server Error", { status: 500 })));
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toBeUndefined();
  });

  it("returns undefined when fetch throws (e.g. network error or aborted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      })
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toBeUndefined();
  });

  it("URL-encodes the path and passes branch and page through as query params", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return commitsResponse(["2026-08-10T00:00:00Z"]);
      })
    );
    await fetchRepoDocDates("alice", "notes", "main", "docs/my notes.md");
    expect(requestedUrl).toBe("/api/repo/alice/notes/commits?branch=main&page=1&path=docs%2Fmy%20notes.md");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- repo-doc-dates.test.ts`
Expected: FAIL — `Cannot find module './repo-doc-dates'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `repo-doc-dates.ts`**

Create `client/src/repo-doc-dates.ts`:

```ts
export interface RepoDocDates {
  createdAt: number;
  updatedAt: number;
}

interface CommitApiEntry {
  commit: { author: { date: string } };
}

// GitHub's Link header looks like:
//   <https://api.github.com/repositories/1/commits?page=2>; rel="next", <...?page=5>; rel="last"
// We only need the page number of the "last" entry.
function parseLastPage(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  const lastPart = linkHeader.split(",").find((part) => part.includes('rel="last"'));
  if (!lastPart) return null;
  const urlMatch = lastPart.match(/<([^>]+)>/);
  if (!urlMatch) return null;
  const page = new URL(urlMatch[1]!).searchParams.get("page");
  return page ? Number(page) : null;
}

async function fetchCommitsPage(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  page: number,
  signal?: AbortSignal
): Promise<{ commits: CommitApiEntry[]; linkHeader: string | null }> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`/api/repo/${owner}/${repo}/commits?branch=${encodeURIComponent(branch)}&page=${page}&path=${encodedPath}`, { signal });
  if (!res.ok) throw new Error(`commits fetch failed: ${res.status}`);
  const commits = (await res.json()) as CommitApiEntry[];
  return { commits, linkHeader: res.headers.get("Link") };
}

// Fetches the creation and last-modified dates for a repo-linked file from
// its real GitHub commit history — the newest commit for `updatedAt`, the
// oldest for `createdAt`. GitHub returns commits newest-first, so finding
// the oldest means jumping straight to the last page via the Link header's
// rel="last" entry rather than walking every page. Returns undefined (never
// throws) on any failure — no commits yet, a failed request, or an aborted
// one — so callers can fall back to local timestamps unconditionally.
export async function fetchRepoDocDates(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  signal?: AbortSignal
): Promise<RepoDocDates | undefined> {
  try {
    const first = await fetchCommitsPage(owner, repo, branch, path, 1, signal);
    if (first.commits.length === 0) return undefined;
    const updatedAt = new Date(first.commits[0]!.commit.author.date).getTime();

    const lastPage = parseLastPage(first.linkHeader);
    if (lastPage === null) {
      const oldest = first.commits[first.commits.length - 1]!;
      return { createdAt: new Date(oldest.commit.author.date).getTime(), updatedAt };
    }

    const last = await fetchCommitsPage(owner, repo, branch, path, lastPage, signal);
    if (last.commits.length === 0) return { createdAt: updatedAt, updatedAt };
    const oldest = last.commits[last.commits.length - 1]!;
    return { createdAt: new Date(oldest.commit.author.date).getTime(), updatedAt };
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- repo-doc-dates.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/repo-doc-dates.ts client/src/repo-doc-dates.test.ts
git commit -m "feat: add fetchRepoDocDates for deriving doc dates from commit history"
```

---

### Task 3: Wire `fetchRepoDocDates` into `DocInfoPanel.svelte`

**Files:**
- Modify: `client/src/components/DocInfoPanel.svelte`

**Interfaces:**
- Consumes: `fetchRepoDocDates(owner, repo, branch, path, signal): Promise<RepoDocDates | undefined>` and `RepoDocDates` from Task 2's `client/src/repo-doc-dates.ts`.

No new automated test — per Global Constraints, this codebase has no Svelte component test infra, and this task is thin glue over the already-tested `fetchRepoDocDates`. Verify live instead (Step 3).

- [ ] **Step 1: Add the reactive fetch and derived display values**

In `client/src/components/DocInfoPanel.svelte`, add the import (after the existing `import { findBacklinks } from "../wikilinks";` on line 7):

```ts
  import { fetchRepoDocDates, type RepoDocDates } from "../repo-doc-dates";
```

Add this state and effect after the existing `charCount` derived value (after line 15, before the `function close()` block):

```ts
  let repoDates = $state<RepoDocDates | undefined>(undefined);

  // Repo-linked docs show their real commit history instead of local
  // timestamps once it resolves — local timestamps render first (no
  // loading flicker) and get replaced in place if this finds something
  // different. Re-runs whenever the panel switches to a different doc;
  // the abort on cleanup stops a slow fetch for a previously-viewed doc
  // from landing after the panel has already moved on and overwriting
  // the wrong document's display.
  $effect(() => {
    repoDates = undefined;
    if (!doc?.repoPath) return;
    const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId);
    const repoLink = workspace?.repoLink;
    if (!repoLink) return;
    const controller = new AbortController();
    fetchRepoDocDates(repoLink.owner, repoLink.repo, repoLink.branch, doc.repoPath, controller.signal).then((dates) => {
      if (!controller.signal.aborted) repoDates = dates;
    });
    return () => controller.abort();
  });

  const displayCreatedAt = $derived(repoDates?.createdAt ?? doc?.createdAt ?? 0);
  const displayUpdatedAt = $derived(repoDates?.updatedAt ?? doc?.updatedAt ?? 0);
```

- [ ] **Step 2: Use the derived values in the template**

Replace the "Created" and "Edited" rows (lines 45-52):

```svelte
    <div class="doc-info-row">
      <span class="doc-info-primary">Created</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(doc.createdAt)} • {formatFullTimestamp(doc.createdAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Edited</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(doc.updatedAt)} • {formatFullTimestamp(doc.updatedAt)}</span>
    </div>
```

with:

```svelte
    <div class="doc-info-row">
      <span class="doc-info-primary">Created</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(displayCreatedAt)} • {formatFullTimestamp(displayCreatedAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Edited</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(displayUpdatedAt)} • {formatFullTimestamp(displayUpdatedAt)}</span>
    </div>
```

- [ ] **Step 3: Verify live in a browser**

Run: `npm run dev:client -- --port 5197` in the background, then in a browser tab:

1. Seed `localStorage` with a workspace linked to a real (or fake, via a stubbed `window.fetch`) repo, and a doc with a `repoPath` matching a file that has multiple commits spanning more than one page (or stub `fetch` for `/api/repo/*/commits*` to return canned multi-page data, following the same pattern used earlier this session to demo Version History's repo commits).
2. Open the Document Info panel for that doc (File > Document Info, or its icon).
3. Confirm "Created" and "Edited" initially show the doc's local timestamps, then update in place shortly after to the commit-derived dates once the fetch resolves — check via `getComputedStyle`/DOM text inspection or just visually.
4. Switch to a different, non-repo-linked doc and open its panel — confirm it shows local timestamps only, with no fetch attempted (check via `read_network_requests` or a console log) and no stale dates from the previous doc.
5. Check the browser console for errors (`read_console_messages`, `onlyErrors: true`).
6. Stop the dev server (`pkill -f "vite dev.*5197"` or equivalent) and close the browser tab when done.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus the ones added in Tasks 1 and 2 (no regressions from the `DocInfoPanel.svelte` change, since it has no dedicated test file).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DocInfoPanel.svelte
git commit -m "feat: show repo commit-derived created/edited dates in Document Info"
```
