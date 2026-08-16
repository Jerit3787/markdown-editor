# GitHub Repo Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace link to a GitHub repo, pull its markdown files in as docs, and push local changes back out as a single atomic commit, with SHA-based per-file conflict detection.

**Architecture:** Server-side handlers in `src/github-repo.ts` proxy GitHub's REST + Git Data API (tree/blob/commit/ref) behind the same encrypted-cookie session `src/github-auth.ts` already uses for Gist calls — the token never reaches the client. Client-side `client/src/repo-sync.ts` holds the pure diff/conflict logic (unit-testable without mocking `fetch`) plus thin orchestration functions that call the new endpoints. Two new Svelte modals (link + conflict resolution) and a File-menu submenu (mirroring the existing Gist submenu) provide the UI.

**Tech Stack:** Cloudflare Workers (TypeScript), GitHub REST + Git Data API, Svelte 5, Vitest.

## Global Constraints

- OAuth scope changes from `"gist"` to `"repo"` — every signed-in user needs to re-authorize once; `handleMe` must report granted scopes so the client can detect a stale grant (per spec's "OAuth scope change" section).
- Sync recurses into the whole repo tree on the linked branch — no subfolder scoping, no non-recursive mode (per spec's Non-goals).
- Only `.md` files become docs. Other files are left untouched except images/diagrams referenced by synced docs, which push as real files under `assets/<doc-slug>/`.
- Conflicts are always surfaced for a per-file "keep mine / take theirs" choice — never silently resolved (per spec's Non-goals and Conflict Resolution UI section).
- Deletions sync both directions: a doc deleted locally deletes its repo file on push; a file deleted from the repo deletes its doc on pull (per spec).
- Push builds one atomic commit via the Git Data API (blob → tree → commit → ref update with `force: false`) — never one commit per file (per spec's Commit Batching decision).
- This feature is independent of workspace-level live sharing (sub-project 2) — no interaction between the two; pushing/pulling always operates on the workspace's current local content regardless of live-share state.

---

### Task 1: OAuth scope change + granted-scope reporting

**Files:**
- Modify: `src/github-auth.ts:29` (scope), `src/github-auth.ts:137-159` (`handleMe`)
- Test: `src/github-auth.test.ts` (new)

**Interfaces:**
- Produces: `handleMe` response body gains `scopes: string[]` (empty array when signed out or when the header was missing/unparseable).

GitHub returns the token's actual granted scopes in the `X-OAuth-Scopes` response header on any authenticated API call — this task captures it from the existing `/user` call `handleMe` already makes, rather than adding a new request.

- [ ] **Step 1: Write the failing test**

Create `src/github-auth.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleMe } from "./github-auth";
import { encryptSession } from "./auth";
import type { Env } from "./env";

const fakeEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!" } as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sessionCookieHeader(token: string, username: string): Promise<string> {
  const session = await encryptSession(fakeEnv, { token, username });
  return `mde_session=${session}`;
}

describe("handleMe", () => {
  it("reports granted scopes from GitHub's X-OAuth-Scopes header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ login: "alice" }), { status: 200, headers: { "X-OAuth-Scopes": "repo, gist" } }))
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/auth/github/me", { headers: { Cookie: cookie } });
    const res = await handleMe(req, fakeEnv);
    const data = await res.json();
    expect(data.connected).toBe(true);
    expect(data.scopes).toEqual(["repo", "gist"]);
  });

  it("reports an empty scopes array when the header is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ login: "alice" }), { status: 200 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/auth/github/me", { headers: { Cookie: cookie } });
    const res = await handleMe(req, fakeEnv);
    const data = await res.json();
    expect(data.scopes).toEqual([]);
  });

  it("reports an empty scopes array when signed out", async () => {
    const req = new Request("https://example.com/api/auth/github/me");
    const res = await handleMe(req, fakeEnv);
    const data = await res.json();
    expect(data.connected).toBe(false);
    expect(data.scopes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/github-auth.test.ts`
Expected: FAIL — `data.scopes` is `undefined`, not `["repo", "gist"]`.

- [ ] **Step 3: Write minimal implementation**

In `src/github-auth.ts`, change the scope requested (line 29):

```typescript
  authorizeUrl.searchParams.set("scope", "repo");
```

Replace `handleMe` (lines 137-159) with:

```typescript
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return Response.json({ connected: false, scopes: [] });

  // Only a 401 from GitHub means the token is definitely invalid/revoked
  // — a 403 (rate-limited), a transient 5xx, or the fetch itself failing
  // outright don't mean that, and signing the user out for any of those
  // would be a false positive. Fail open: trust the locally-decrypted
  // session unless GitHub explicitly says the token is no good.
  let scopes: string[] = [];
  try {
    const userRes = await fetch(`${API}/user`, { headers: ghHeaders(session.token) });
    if (userRes.status === 401) {
      const headers = new Headers();
      headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0 }));
      return Response.json({ connected: false, scopes: [] }, { headers });
    }
    const scopeHeader = userRes.headers.get("X-OAuth-Scopes");
    if (scopeHeader) scopes = scopeHeader.split(",").map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    // Couldn't reach GitHub to verify — fall through and trust the
    // local session rather than signing the user out over a network blip.
  }

  return Response.json({ connected: true, username: session.username, scopes });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/github-auth.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/github-auth.ts src/github-auth.test.ts
git commit -m "feat: request repo OAuth scope, report granted scopes from handleMe"
```

---

### Task 2: Repo list + create endpoints

**Files:**
- Create: `src/github-repo.ts`
- Test: `src/github-repo.test.ts`

**Interfaces:**
- Consumes: `getSession`-equivalent session lookup (this file needs its own copy — `github-auth.ts`'s `getSession`/`ghHeaders`/`safeJson` are not exported; duplicate the same three small helpers here rather than reaching into that module's internals).
- Produces: `handleRepoList(request, env): Promise<Response>`, `handleRepoCreate(request, env): Promise<Response>`, plus the shared private helpers `getSession`/`ghHeaders`/`proxyJson`/`safeJson` that every later task in this file (Tasks 3-4) reuses without redefining. `safeJson` has no caller yet in this task — Task 3 is its first consumer — which is fine and expected, not dead code to remove.

- [ ] **Step 1: Write the failing test**

Create `src/github-repo.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleRepoList, handleRepoCreate } from "./github-repo";
import { encryptSession } from "./auth";
import type { Env } from "./env";

const fakeEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!" } as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sessionCookieHeader(token: string, username: string): Promise<string> {
  const session = await encryptSession(fakeEnv, { token, username });
  return `mde_session=${session}`;
}

describe("handleRepoList", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/list");
    const res = await handleRepoList(req, fakeEnv);
    expect(res.status).toBe(401);
  });

  it("proxies the user's repos when signed in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ full_name: "alice/notes", private: true, default_branch: "main" }]), { status: 200 }))
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/list", { headers: { Cookie: cookie } });
    const res = await handleRepoList(req, fakeEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([{ full_name: "alice/notes", private: true, default_branch: "main" }]);
  });
});

describe("handleRepoCreate", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/create", { method: "POST", body: JSON.stringify({ name: "notes" }) });
    const res = await handleRepoCreate(req, fakeEnv);
    expect(res.status).toBe(401);
  });

  it("creates a repo with the requested visibility", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ name: "notes", private: true, auto_init: true });
      return new Response(JSON.stringify({ full_name: "alice/notes", private: true, default_branch: "main" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/create", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ name: "notes", private: true }),
    });
    const res = await handleRepoCreate(req, fakeEnv);
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/github-repo.test.ts`
Expected: FAIL — `./github-repo` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/github-repo.ts`:

```typescript
// GitHub repo-sync endpoints — parallel to the Gist ones in github-auth.ts,
// using the same encrypted-cookie session. This file duplicates
// getSession/ghHeaders/safeJson rather than importing github-auth.ts's
// (unexported) copies, keeping the two integrations independently
// readable — they diverge in scope (repo vs gist) and will keep diverging
// as this file grows push/pull-specific logic github-auth.ts has no need for.
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import type { Env, SessionData } from "./env";

const API = "https://api.github.com";
const USER_AGENT = "markdown-editor-app (+https://editor.danplace.tech)";

export async function handleRepoList(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/user/repos?per_page=100&sort=updated`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}

export async function handleRepoCreate(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  let body: { name?: unknown; private?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return new Response("name is required.", { status: 400 });
  const isPrivate = body.private !== false; // defaults to private, matching the spec's "most people's real notes are private" reasoning
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(session.token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
  });
  return proxyJson(res);
}

async function getSession(request: Request, env: Env): Promise<SessionData | null> {
  const cookie = getCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  return decryptSession(env, cookie);
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

async function proxyJson(res: Response): Promise<Response> {
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/github-repo.ts src/github-repo.test.ts
git commit -m "feat: add repo list/create endpoints"
```

---

### Task 3: Tree + blob fetch endpoints

**Files:**
- Modify: `src/github-repo.ts`
- Test: `src/github-repo.test.ts`

**Interfaces:**
- Consumes: `getSession`, `ghHeaders`, `proxyJson`, `safeJson` (private helpers already in this file from Task 2).
- Produces: `handleRepoTree(request, env, owner, repo, branch): Promise<Response>` — response body `{ commitSha: string, treeSha: string, tree: TreeEntry[] }` (not a passthrough of GitHub's raw tree response — resolves the branch to its commit sha first so Task 4's push endpoint has a commit sha to use as the new commit's parent, which the tree endpoint alone can't supply). `handleRepoBlob(request, env, owner, repo, sha): Promise<Response>`, exported type `TreeEntry { path: string; sha: string; type: "blob" | "tree" }`, exported pure function `filterMarkdownEntries(entries: TreeEntry[]): TreeEntry[]` (used by both this handler and Task 9's client-side pull planner as the shared definition of "which tree entries are markdown docs").

- [ ] **Step 1: Write the failing test**

Add to `src/github-repo.test.ts`:

```typescript
import { handleRepoTree, handleRepoBlob, filterMarkdownEntries } from "./github-repo";

describe("filterMarkdownEntries", () => {
  it("keeps only blob entries ending in .md, at any depth", () => {
    const entries = [
      { path: "README.md", sha: "a", type: "blob" as const },
      { path: "docs", sha: "b", type: "tree" as const },
      { path: "docs/notes.md", sha: "c", type: "blob" as const },
      { path: "assets/logo.png", sha: "d", type: "blob" as const },
      { path: "notes.MD", sha: "e", type: "blob" as const },
    ];
    expect(filterMarkdownEntries(entries)).toEqual([
      { path: "README.md", sha: "a", type: "blob" },
      { path: "docs/notes.md", sha: "c", type: "blob" },
      { path: "notes.MD", sha: "e", type: "blob" },
    ]);
  });
});

describe("handleRepoTree", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/tree?branch=main");
    const res = await handleRepoTree(req, fakeEnv, "alice", "notes", "main");
    expect(res.status).toBe(401);
  });

  it("resolves the branch to a commit sha first, then fetches that commit's tree", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "https://api.github.com/repos/alice/notes/git/refs/heads/main") {
          return new Response(JSON.stringify({ object: { sha: "commit-sha" } }), { status: 200 });
        }
        if (url === "https://api.github.com/repos/alice/notes/git/trees/commit-sha?recursive=1") {
          return new Response(JSON.stringify({ sha: "tree-sha", tree: [{ path: "a.md", sha: "x", type: "blob" }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoTree(req, fakeEnv, "alice", "notes", "main");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ commitSha: "commit-sha", treeSha: "tree-sha", tree: [{ path: "a.md", sha: "x", type: "blob" }] });
    expect(calls).toEqual([
      "https://api.github.com/repos/alice/notes/git/refs/heads/main",
      "https://api.github.com/repos/alice/notes/git/trees/commit-sha?recursive=1",
    ]);
  });
});

describe("handleRepoBlob", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/blob/x");
    const res = await handleRepoBlob(req, fakeEnv, "alice", "notes", "x");
    expect(res.status).toBe(401);
  });

  it("fetches a blob by sha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/git/blobs/x");
        return new Response(JSON.stringify({ sha: "x", content: "aGVsbG8=", encoding: "base64" }), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/blob/x", { headers: { Cookie: cookie } });
    const res = await handleRepoBlob(req, fakeEnv, "alice", "notes", "x");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe("aGVsbG8=");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/github-repo.test.ts`
Expected: FAIL — `handleRepoTree`, `handleRepoBlob`, `filterMarkdownEntries` don't exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `src/github-repo.ts`:

```typescript
export interface TreeEntry {
  path: string;
  sha: string;
  type: "blob" | "tree";
}

export function filterMarkdownEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.filter((e) => e.type === "blob" && /\.md$/i.test(e.path));
}

// Resolves the branch to its current commit sha first, then fetches that
// exact commit's tree — rather than passing the branch name straight to
// the trees endpoint (which GitHub also accepts and resolves internally).
// The two-step version costs one extra request but means the response can
// hand back the commit sha too: Task 4's push endpoint needs it (as
// parents[0] for the new commit) and has no other way to get it, since
// nothing else in this file resolves a branch to a commit.
export async function handleRepoTree(request: Request, env: Env, owner: string, repo: string, branch: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const headers = ghHeaders(session.token);
  const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { headers });
  if (!refRes.ok) return proxyJson(refRes);
  const refData = await safeJson<{ object: { sha: string } }>(refRes);
  if (!refData) return new Response("Failed to resolve branch: invalid response", { status: 502 });
  const commitSha = refData.object.sha;

  const treeRes = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`, { headers });
  if (!treeRes.ok) return proxyJson(treeRes);
  const treeData = await safeJson<{ sha: string; tree: TreeEntry[] }>(treeRes);
  if (!treeData) return new Response("Failed to fetch tree: invalid response", { status: 502 });

  return Response.json({ commitSha, treeSha: treeData.sha, tree: treeData.tree });
}

export async function handleRepoBlob(request: Request, env: Env, owner: string, repo: string, sha: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/github-repo.ts src/github-repo.test.ts
git commit -m "feat: add repo tree/blob fetch endpoints"
```

---

### Task 4: Atomic push endpoint

**Files:**
- Modify: `src/github-repo.ts`
- Test: `src/github-repo.test.ts`

**Interfaces:**
- Consumes: `getSession`, `ghHeaders`, `safeJson`, `API`, `USER_AGENT` (private helpers/consts already in this file, from Task 2).
- Produces:
  - `interface PushBlob { path: string; contentBase64: string }` (a file to create/update — path relative to repo root, content base64-encoded, used for both markdown and image blobs)
  - `interface PushRequestBody { branch: string; baseTreeSha: string; parentCommitSha: string; blobs: PushBlob[]; deletePaths: string[] }` (`baseTreeSha` is a tree sha, used as the new tree's `base_tree`; `parentCommitSha` is the branch head's current *commit* sha, used as the new commit's `parents[0]` — these are different values and must not be conflated)
  - `computeNewTreeEntries(baseTreeEntries: TreeEntry[], blobShas: { path: string; sha: string }[], deletePaths: string[]): { path: string; mode: "100644"; type: "blob"; sha: string | null }[]` — pure function building the git tree API's `tree` array: updates/adds entries for `blobShas`, omits (sets `sha: null` for, per the Git Data API's own delete convention) entries in `deletePaths`, leaves every other existing entry alone by reusing its `sha` unchanged (this task does not need `baseTreeEntries`' `type: "tree"` rows — GitHub's tree-creation API resolves subtree shas on its own when given a flat list of blob paths with `base_tree` set, so only blob-type entries need representing here).
  - `handleRepoPush(request, env, owner, repo): Promise<Response>` — on ref-update rejection (branch moved), returns `409` with `{ conflict: true }`; on success returns `200` with `{ commitSha: string, blobShas: Record<string, string> }` (path → new blob sha, so the client can update every pushed doc's `repoSha` without a second round trip).

- [ ] **Step 1: Write the failing test**

Add to `src/github-repo.test.ts`:

```typescript
import { handleRepoPush, computeNewTreeEntries } from "./github-repo";

describe("computeNewTreeEntries", () => {
  it("adds new blob paths and updates existing ones", () => {
    const result = computeNewTreeEntries(
      [{ path: "a.md", sha: "old-a", type: "blob" }],
      [
        { path: "a.md", sha: "new-a" },
        { path: "b.md", sha: "new-b" },
      ],
      []
    );
    expect(result).toEqual([
      { path: "a.md", mode: "100644", type: "blob", sha: "new-a" },
      { path: "b.md", mode: "100644", type: "blob", sha: "new-b" },
    ]);
  });

  it("marks deleted paths with a null sha, leaves untouched paths out entirely", () => {
    const result = computeNewTreeEntries([{ path: "a.md", sha: "old-a", type: "blob" }], [], ["a.md"]);
    expect(result).toEqual([{ path: "a.md", mode: "100644", type: "blob", sha: null }]);
  });
});

describe("handleRepoPush", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/push", { method: "POST", body: "{}" });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(401);
  });

  it("builds one commit from blobs+tree+commit+ref calls, returns new blob shas", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        if (url.endsWith("/git/blobs")) {
          const body = JSON.parse(init!.body as string);
          return new Response(JSON.stringify({ sha: `sha-${body.content.slice(0, 4)}` }), { status: 201 });
        }
        if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "new-tree-sha" }), { status: 201 });
        if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "new-commit-sha" }), { status: 201 });
        if (url.includes("/git/refs/heads/")) return new Response(JSON.stringify({ ref: "refs/heads/main" }), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: "base-tree",
        parentCommitSha: "parent-commit-sha",
        blobs: [{ path: "a.md", contentBase64: "aGVsbG8=" }],
        deletePaths: [],
      }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commitSha).toBe("new-commit-sha");
    expect(data.blobShas["a.md"]).toBe("sha-aGVs");
    expect(calls).toEqual([
      "https://api.github.com/repos/alice/notes/git/blobs",
      "https://api.github.com/repos/alice/notes/git/trees",
      "https://api.github.com/repos/alice/notes/git/commits",
      "https://api.github.com/repos/alice/notes/git/refs/heads/main",
    ]);
  });

  it("returns 409 with conflict:true when the ref update is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/git/blobs")) return new Response(JSON.stringify({ sha: "s" }), { status: 201 });
        if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "t" }), { status: 201 });
        if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "c" }), { status: 201 });
        return new Response(JSON.stringify({ message: "Update is not a fast forward" }), { status: 422 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: "base-tree",
        parentCommitSha: "parent-commit-sha",
        blobs: [{ path: "a.md", contentBase64: "aGk=" }],
        deletePaths: [],
      }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.conflict).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/github-repo.test.ts`
Expected: FAIL — `handleRepoPush`, `computeNewTreeEntries` don't exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `src/github-repo.ts`:

```typescript
export function computeNewTreeEntries(
  baseTreeEntries: TreeEntry[],
  blobShas: { path: string; sha: string }[],
  deletePaths: string[]
): { path: string; mode: "100644"; type: "blob"; sha: string | null }[] {
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  for (const { path, sha } of blobShas) entries.push({ path, mode: "100644", type: "blob", sha });
  for (const path of deletePaths) entries.push({ path, mode: "100644", type: "blob", sha: null });
  return entries;
}

export async function handleRepoPush(request: Request, env: Env, owner: string, repo: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });

  let body: { branch?: unknown; baseTreeSha?: unknown; parentCommitSha?: unknown; blobs?: unknown; deletePaths?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const branch = typeof body.branch === "string" ? body.branch : "";
  // baseTreeSha (a *tree* sha) becomes the new tree's base_tree below;
  // parentCommitSha (a *commit* sha — the branch head's current commit,
  // distinct from its tree) becomes the new commit's parents[0]. Mixing
  // these up produces a commit whose parent doesn't match its own tree's
  // base, which the ref-update step below would then reject.
  const baseTreeSha = typeof body.baseTreeSha === "string" ? body.baseTreeSha : "";
  const parentCommitSha = typeof body.parentCommitSha === "string" ? body.parentCommitSha : "";
  const blobs = Array.isArray(body.blobs) ? (body.blobs as { path: string; contentBase64: string }[]) : [];
  const deletePaths = Array.isArray(body.deletePaths) ? (body.deletePaths as string[]) : [];
  if (!branch || !baseTreeSha || !parentCommitSha) {
    return new Response("branch, baseTreeSha, and parentCommitSha are required.", { status: 400 });
  }

  const headers = { ...ghHeaders(session.token), "Content-Type": "application/json" };
  const base = `${API}/repos/${owner}/${repo}`;

  const blobShas: Record<string, string> = {};
  for (const blob of blobs) {
    const res = await fetch(`${base}/git/blobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: blob.contentBase64, encoding: "base64" }),
    });
    if (!res.ok) return new Response(`Failed to create blob for ${blob.path}: ${await res.text()}`, { status: 502 });
    const data = await safeJson<{ sha: string }>(res);
    if (!data) return new Response(`Failed to create blob for ${blob.path}: invalid response`, { status: 502 });
    blobShas[blob.path] = data.sha;
  }

  const treeEntries = computeNewTreeEntries(
    [],
    blobs.map((b) => ({ path: b.path, sha: blobShas[b.path]! })),
    deletePaths
  );
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });
  if (!treeRes.ok) return new Response(`Failed to build tree: ${await treeRes.text()}`, { status: 502 });
  const treeData = await safeJson<{ sha: string }>(treeRes);
  if (!treeData) return new Response("Failed to build tree: invalid response", { status: 502 });

  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: "Update from Markdown Editor",
      tree: treeData.sha,
      parents: [parentCommitSha],
    }),
  });
  if (!commitRes.ok) return new Response(`Failed to create commit: ${await commitRes.text()}`, { status: 502 });
  const commitData = await safeJson<{ sha: string }>(commitRes);
  if (!commitData) return new Response("Failed to create commit: invalid response", { status: 502 });

  const refRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ sha: commitData.sha, force: false }),
  });
  if (!refRes.ok) {
    return Response.json({ conflict: true, message: await refRes.text() }, { status: 409 });
  }

  return Response.json({ commitSha: commitData.sha, blobShas });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/github-repo.ts src/github-repo.test.ts
git commit -m "feat: add atomic repo push endpoint (blob/tree/commit/ref)"
```

---

### Task 5: Wire routes into the Worker

**Files:**
- Modify: `src/worker.ts`

**Interfaces:**
- Consumes: `handleRepoList`, `handleRepoCreate`, `handleRepoTree`, `handleRepoBlob`, `handleRepoPush` from `./github-repo.js` (Tasks 2-4).

- [ ] **Step 1: Add route matching and imports**

In `src/worker.ts`, add to the import block (after the `github-auth.js` import):

```typescript
import { handleRepoList, handleRepoCreate, handleRepoTree, handleRepoBlob, handleRepoPush } from "./github-repo.js";
```

Add near the other path regexes (after `GIST_IMAGE_PATH`):

```typescript
const REPO_TREE_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/tree$/;
const REPO_BLOB_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]+)$/i;
const REPO_PUSH_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/push$/;
```

Add route handling inside `fetch()`, right after the existing Gist routes and before `return env.ASSETS.fetch(request);`:

```typescript
    if (url.pathname === "/api/repo/list" && request.method === "GET") return handleRepoList(request, env);
    if (url.pathname === "/api/repo/create" && request.method === "POST") return handleRepoCreate(request, env);

    const repoTreeMatch = url.pathname.match(REPO_TREE_PATH);
    if (repoTreeMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      return handleRepoTree(request, env, repoTreeMatch[1]!, repoTreeMatch[2]!, branch);
    }

    const repoBlobMatch = url.pathname.match(REPO_BLOB_PATH);
    if (repoBlobMatch && request.method === "GET") return handleRepoBlob(request, env, repoBlobMatch[1]!, repoBlobMatch[2]!, repoBlobMatch[3]!);

    const repoPushMatch = url.pathname.match(REPO_PUSH_PATH);
    if (repoPushMatch && request.method === "POST") return handleRepoPush(request, env, repoPushMatch[1]!, repoPushMatch[2]!);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Manual smoke test**

Run: `npm test`
Expected: all existing + new tests still pass (server test suite unaffected by routing changes, but this confirms nothing broke).

- [ ] **Step 4: Commit**

```bash
git add src/worker.ts
git commit -m "feat: wire repo sync routes into the Worker"
```

---

### Task 6: Type additions

**Files:**
- Modify: `client/src/types.ts`

**Interfaces:**
- Produces: `Workspace.repoLink?: { owner: string; repo: string; branch: string }`, `Doc.repoPath?: string`, `Doc.repoSha?: string`, `Doc.repoImageShas?: Record<string, string>`.

- [ ] **Step 1: Add the fields**

In `client/src/types.ts`, add to the `Workspace` interface (after the `remoteId` field, before its closing brace):

```typescript
  // Set once this workspace has been linked to a GitHub repo — see
  // client/src/repo-sync.ts. Independent of `shared`/`remoteId`: a
  // workspace can be live-shared, repo-linked, both, or neither.
  repoLink?: {
    owner: string;
    repo: string;
    branch: string;
  };
```

Add to the `Doc` interface (after the `gistFilename` field):

```typescript
  // Path within the linked workspace's repo (e.g. "docs/notes.md"),
  // once this doc has been pulled from or pushed to it at least once.
  // Parallel to gistId/gistFilename above.
  repoPath?: string;
  // The blob SHA this doc's content was last synced at — repo-sync's
  // conflict-detection signal: a mismatch against the repo's current
  // tree means something else changed the file since last sync.
  repoSha?: string;
  // Same idea as repoSha, but per embedded image/diagram ref (see
  // doc.images/doc.diagrams) — each pushed image is its own blob with
  // its own SHA to track.
  repoImageShas?: Record<string, string>;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/types.ts
git commit -m "feat: add repo-link fields to Workspace/Doc types"
```

---

### Task 7: Workspace repo-link store actions

**Files:**
- Modify: `client/src/stores/workspaces.ts`
- Test: `client/src/stores/workspaces.test.ts` (new, or add to it if one already exists — check first with `ls client/src/stores/workspaces.test.ts`)

**Interfaces:**
- Consumes: `workspacesStore`, `persistWorkspaces` (already in this file).
- Produces: `setWorkspaceRepoLink(id: string, repoLink: { owner: string; repo: string; branch: string }): void`, `clearWorkspaceRepoLink(id: string): void`.

- [ ] **Step 1: Write the failing test**

If `client/src/stores/workspaces.test.ts` doesn't exist, create it with this content. If it exists, add these two `describe` blocks to it.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, clearWorkspaceRepoLink } from "./workspaces";

beforeEach(() => {
  localStorage.clear();
  workspacesStore.set([]);
});

describe("setWorkspaceRepoLink", () => {
  it("sets repoLink on the matching workspace, leaves others untouched", () => {
    const ws = createWorkspace("Notes");
    const other = createWorkspace("Other");
    setWorkspaceRepoLink(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    const all = get(workspacesStore);
    expect(all.find((w) => w.id === ws.id)?.repoLink).toEqual({ owner: "alice", repo: "notes", branch: "main" });
    expect(all.find((w) => w.id === other.id)?.repoLink).toBeUndefined();
  });
});

describe("clearWorkspaceRepoLink", () => {
  it("removes repoLink from the matching workspace", () => {
    const ws = createWorkspace("Notes");
    setWorkspaceRepoLink(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    clearWorkspaceRepoLink(ws.id);
    expect(get(workspacesStore).find((w) => w.id === ws.id)?.repoLink).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/stores/workspaces.test.ts`
Expected: FAIL — `setWorkspaceRepoLink`/`clearWorkspaceRepoLink` don't exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `client/src/stores/workspaces.ts` (after `mergeSharedWorkspaceInto`):

```typescript
export function setWorkspaceRepoLink(id: string, repoLink: { owner: string; repo: string; branch: string }): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink } : w)));
  persistWorkspaces();
}

export function clearWorkspaceRepoLink(id: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink: undefined } : w)));
  persistWorkspaces();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/stores/workspaces.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/workspaces.ts client/src/stores/workspaces.test.ts
git commit -m "feat: add setWorkspaceRepoLink/clearWorkspaceRepoLink"
```

---

### Task 8: Doc store bulk helpers for repo sync

**Files:**
- Modify: `client/src/stores/docs.ts`
- Test: `client/src/stores/docs.test.ts` (add to existing, or check with `ls`)

**Interfaces:**
- Consumes: `docsStore`, `persistDocs`, `activeIdStore`, `setActiveId`-equivalent logic, `uid()`, `ensureUniqueName`, `nextAvailableName` (already in this file).
- Produces:
  - `docsInWorkspace(workspaceId: string): Doc[]` — every doc currently in the given workspace, for the push planner to enumerate.
  - `upsertDocFromRepo(workspaceId: string, repoPath: string, data: { name: string; content: string; images?: Record<string, string>; diagrams?: Record<string, string>; repoSha: string; repoImageShas?: Record<string, string> }): void` — creates a new doc if no doc in the workspace has this `repoPath` yet, otherwise updates the existing one's content/images/diagrams/SHAs in place (does not touch `id`/`createdAt`/name-uniqueness bookkeeping on update — matching `updateDoc`'s existing merge semantics).
  - `removeDocsByRepoPaths(workspaceId: string, repoPaths: string[]): void` — bulk delete, mirrors `removeDocById`'s active-doc-fallback behavior but batched.
  - `setDocRepoLinkById(id: string, repoPath: string, repoSha: string, repoImageShas: Record<string, string> | undefined): void` — push-side bookkeeping after a successful push; unlike `setActiveDocGistId`, this operates on an arbitrary doc id since push can update many non-active docs in one pass.

- [ ] **Step 1: Write the failing test**

If `client/src/stores/docs.test.ts` doesn't exist, check with `ls client/src/stores/docs.test.ts` first — if it exists, add these `describe` blocks to it; otherwise create it with this content plus the necessary setup (a workspace must exist before `docsInWorkspace`/`upsertDocFromRepo` are meaningful):

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { docsStore, docsInWorkspace, upsertDocFromRepo, removeDocsByRepoPaths, setDocRepoLinkById, createDoc } from "./docs";
import { workspacesStore, createWorkspace } from "./workspaces";

beforeEach(() => {
  localStorage.clear();
  workspacesStore.set([]);
  docsStore.set([]);
});

describe("docsInWorkspace", () => {
  it("returns only docs belonging to the given workspace", () => {
    const wsA = createWorkspace("A");
    const docA = createDoc({ workspaceId: wsA.id, name: "a" });
    const wsB = createWorkspace("B");
    createDoc({ workspaceId: wsB.id, name: "b" });
    expect(docsInWorkspace(wsA.id).map((d) => d.id)).toEqual([docA.id]);
  });
});

describe("upsertDocFromRepo", () => {
  it("creates a new doc when no doc in the workspace has this repoPath", () => {
    const ws = createWorkspace("Notes");
    upsertDocFromRepo(ws.id, "notes.md", { name: "notes", content: "hello", repoSha: "sha1" });
    const docs = docsInWorkspace(ws.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: "notes", content: "hello", repoPath: "notes.md", repoSha: "sha1", workspaceId: ws.id });
  });

  it("updates the existing doc in place when repoPath already matches", () => {
    const ws = createWorkspace("Notes");
    upsertDocFromRepo(ws.id, "notes.md", { name: "notes", content: "v1", repoSha: "sha1" });
    const firstId = docsInWorkspace(ws.id)[0]!.id;
    upsertDocFromRepo(ws.id, "notes.md", { name: "notes", content: "v2", repoSha: "sha2" });
    const docs = docsInWorkspace(ws.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(firstId);
    expect(docs[0]!.content).toBe("v2");
    expect(docs[0]!.repoSha).toBe("sha2");
  });
});

describe("removeDocsByRepoPaths", () => {
  it("removes every doc in the workspace matching one of the given paths", () => {
    const ws = createWorkspace("Notes");
    upsertDocFromRepo(ws.id, "a.md", { name: "a", content: "", repoSha: "s1" });
    upsertDocFromRepo(ws.id, "b.md", { name: "b", content: "", repoSha: "s2" });
    removeDocsByRepoPaths(ws.id, ["a.md"]);
    const docs = docsInWorkspace(ws.id);
    expect(docs.map((d) => d.repoPath)).toEqual(["b.md"]);
  });
});

describe("setDocRepoLinkById", () => {
  it("sets repoPath/repoSha/repoImageShas on the given doc id", () => {
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a" });
    setDocRepoLinkById(doc.id, "a.md", "sha1", { "img-1": "imgsha1" });
    const found = docsInWorkspace(ws.id).find((d) => d.id === doc.id);
    expect(found).toMatchObject({ repoPath: "a.md", repoSha: "sha1", repoImageShas: { "img-1": "imgsha1" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: FAIL — the four new exports don't exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `client/src/stores/docs.ts` (after `moveDocToWorkspace`, at the end of the file):

```typescript
export function docsInWorkspace(workspaceId: string): Doc[] {
  return get(docsStore).filter((d) => d.workspaceId === workspaceId);
}

export function upsertDocFromRepo(
  workspaceId: string,
  repoPath: string,
  data: {
    name: string;
    content: string;
    images?: Record<string, string>;
    diagrams?: Record<string, string>;
    repoSha: string;
    repoImageShas?: Record<string, string>;
  }
): void {
  const existing = docsInWorkspace(workspaceId).find((d) => d.repoPath === repoPath);
  if (existing) {
    updateDoc(existing.id, {
      content: data.content,
      images: data.images,
      diagrams: data.diagrams,
      repoSha: data.repoSha,
      repoImageShas: data.repoImageShas,
      updatedAt: Date.now(),
    });
  } else {
    const doc: Doc = {
      id: uid(),
      name: data.name,
      content: data.content,
      images: data.images,
      diagrams: data.diagrams,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      workspaceId,
      repoPath,
      repoSha: data.repoSha,
      repoImageShas: data.repoImageShas,
    };
    doc.name = ensureUniqueName(doc.name, get(docsStore));
    docsStore.update((docs) => [doc, ...docs]);
  }
  persistDocs();
}

export function removeDocsByRepoPaths(workspaceId: string, repoPaths: string[]): void {
  const paths = new Set(repoPaths);
  const toRemove = docsInWorkspace(workspaceId).filter((d) => d.repoPath && paths.has(d.repoPath));
  for (const doc of toRemove) removeDocById(doc.id);
}

export function setDocRepoLinkById(id: string, repoPath: string, repoSha: string, repoImageShas: Record<string, string> | undefined): void {
  updateDoc(id, { repoPath, repoSha, repoImageShas });
  persistDocs();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/docs.ts client/src/stores/docs.test.ts
git commit -m "feat: add doc store bulk helpers for repo sync"
```

---

### Task 9: Path helpers + image rewrite/resolve

**Files:**
- Create: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Produces:
  - `slugifyDocName(name: string): string` — e.g. `"My Notes!"` → `"my-notes"`; `""`/all-punctuation → `"untitled"`.
  - `dedupeRepoPath(basePath: string, existingPaths: Set<string>): string` — e.g. `"notes.md"` vs. an already-taken `"notes.md"` → `"notes-2.md"` (append `-N` before the `.md` extension, same increment-until-free approach as `nextAvailableName`).
  - `interface ImageAsset { path: string; dataUrl: string }`
  - `rewriteImagesForPush(content: string, docSlug: string, images: Record<string, string> | undefined, diagrams: Record<string, string> | undefined): { content: string; assets: ImageAsset[] }` — finds every `![alt](ref)` in `content` whose `ref` resolves against `images` or `diagrams`, rewrites the link to `assets/<docSlug>/<ref-with-extension>`, and returns the collected assets to push as blobs. Mirrors `gist.ts`'s `pushImagesAndRewrite`/`MARKDOWN_IMAGE_RE`, but produces relative repo paths instead of gist URLs, and returns data synchronously (no network calls — those happen in Task 11's orchestration).
  - `resolveImagesFromPull(content: string, docSlug: string, blobs: Record<string, string>): { content: string; images: Record<string, string> }` — the inverse: finds `![alt](assets/<docSlug>/...)` links in pulled `content`, looks up each referenced path in `blobs` (path → already-fetched base64 data URI), rewrites the markdown back to an internal `img-<n>` ref (same shape as `extractInlineImages`'s output), and returns the new `images` map.

- [ ] **Step 1: Write the failing test**

Create `client/src/repo-sync.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { slugifyDocName, dedupeRepoPath, rewriteImagesForPush, resolveImagesFromPull } from "./repo-sync";

describe("slugifyDocName", () => {
  it("lowercases, replaces spaces and punctuation with hyphens", () => {
    expect(slugifyDocName("My Notes!")).toBe("my-notes");
  });
  it("falls back to untitled for empty or all-punctuation names", () => {
    expect(slugifyDocName("")).toBe("untitled");
    expect(slugifyDocName("!!!")).toBe("untitled");
  });
});

describe("dedupeRepoPath", () => {
  it("returns the base path unchanged when not taken", () => {
    expect(dedupeRepoPath("notes.md", new Set())).toBe("notes.md");
  });
  it("appends -2, -3... before the extension until free", () => {
    expect(dedupeRepoPath("notes.md", new Set(["notes.md"]))).toBe("notes-2.md");
    expect(dedupeRepoPath("notes.md", new Set(["notes.md", "notes-2.md"]))).toBe("notes-3.md");
  });
});

describe("rewriteImagesForPush", () => {
  it("rewrites an image ref to a relative assets path and returns it as an asset to push", () => {
    const result = rewriteImagesForPush("![a photo](img-1)", "my-notes", { "img-1": "data:image/png;base64,aGVsbG8=" }, undefined);
    expect(result.content).toBe("![a photo](assets/my-notes/img-1.png)");
    expect(result.assets).toEqual([{ path: "assets/my-notes/img-1.png", dataUrl: "data:image/png;base64,aGVsbG8=" }]);
  });

  it("leaves refs with no matching image/diagram untouched", () => {
    const result = rewriteImagesForPush("![x](https://example.com/x.png)", "my-notes", {}, undefined);
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.assets).toEqual([]);
  });
});

describe("resolveImagesFromPull", () => {
  it("resolves an assets-relative link back to an internal ref and an images entry", () => {
    const result = resolveImagesFromPull("![a photo](assets/my-notes/img-1.png)", "my-notes", {
      "assets/my-notes/img-1.png": "data:image/png;base64,aGVsbG8=",
    });
    expect(result.content).toMatch(/^!\[a photo\]\(img-\d+\)$/);
    const ref = result.content.match(/\(([^)]+)\)/)![1]!;
    expect(result.images[ref]).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("leaves links with no matching blob untouched", () => {
    const result = resolveImagesFromPull("![x](https://example.com/x.png)", "my-notes", {});
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.images).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `./repo-sync` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/repo-sync.ts`:

```typescript
// GitHub repo-sync: pure path/content-transform helpers (this task),
// pull/push diff planners (Tasks 10-11), and orchestration (fetch calls
// to /api/repo/*, also Tasks 10-11). Kept pure-function-first so the
// diff/conflict logic is unit-testable without mocking fetch — the same
// reasoning src/github-repo.ts's computeNewTreeEntries follows server-side.

export function slugifyDocName(name: string): string {
  const slug = (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function dedupeRepoPath(basePath: string, existingPaths: Set<string>): string {
  if (!existingPaths.has(basePath)) return basePath;
  const extMatch = basePath.match(/^(.*)(\.[^./]+)$/);
  const stem = extMatch ? extMatch[1]! : basePath;
  const ext = extMatch ? extMatch[2]! : "";
  let n = 2;
  while (existingPaths.has(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

export interface ImageAsset {
  path: string;
  dataUrl: string;
}

function extFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
  if (!match) return "png";
  const sub = match[1]!.split("+")[0]!.toLowerCase();
  return sub === "jpeg" ? "jpg" : sub;
}

export function rewriteImagesForPush(
  content: string,
  docSlug: string,
  images: Record<string, string> | undefined,
  diagrams: Record<string, string> | undefined
): { content: string; assets: ImageAsset[] } {
  const assets: ImageAsset[] = [];
  const seenRefs = new Map<string, string>(); // ref -> assigned assets path, so repeats reuse the same path
  const newContent = content.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    const dataUrl = (images && images[ref]) || (diagrams && diagrams[ref]);
    if (!dataUrl) return match;
    let assetPath = seenRefs.get(ref);
    if (!assetPath) {
      const hasExt = /\.[a-zA-Z0-9]+$/.test(ref);
      assetPath = `assets/${docSlug}/${hasExt ? ref : `${ref}.${extFromDataUrl(dataUrl)}`}`;
      seenRefs.set(ref, assetPath);
      assets.push({ path: assetPath, dataUrl });
    }
    return `![${alt}](${assetPath})`;
  });
  return { content: newContent, assets };
}

export function resolveImagesFromPull(content: string, docSlug: string, blobs: Record<string, string>): { content: string; images: Record<string, string> } {
  const images: Record<string, string> = {};
  let counter = 0;
  const prefix = `assets/${docSlug}/`;
  const newContent = content.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    if (!ref.startsWith(prefix) || !blobs[ref]) return match;
    counter++;
    const internalRef = `img-${Date.now().toString(36)}-${counter}`;
    images[internalRef] = blobs[ref]!;
    return `![${alt}](${internalRef})`;
  });
  return { content: newContent, images };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: add repo-sync path and image rewrite/resolve helpers"
```

---

### Task 10: Pull planner + orchestration

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `TreeEntry` (mirror the server's `src/github-repo.ts` type locally — client and server don't share a types module, so redeclare it identically here), `resolveImagesFromPull`, `slugifyDocName` (Task 9); `Doc` type (`./types`); `docsInWorkspace`, `upsertDocFromRepo`, `removeDocsByRepoPaths` (`./stores/docs`, Task 8).
- Produces:
  - `interface PullConflict { docId: string; repoPath: string; localContent: string; remoteSha: string }`
  - `interface PullPlan { creates: { repoPath: string; sha: string }[]; updates: { docId: string; repoPath: string; sha: string }[]; conflicts: PullConflict[]; deletions: { docId: string; repoPath: string }[] }`
  - `planPull(mdEntries: TreeEntry[], docs: Doc[], dirtyDocIds: Set<string>): PullPlan` — pure; `dirtyDocIds` is the set of doc ids with local edits since their last sync (the caller determines this by comparing `doc.updatedAt` against a per-doc "last synced at" timestamp it tracks — see the orchestration function below for how that's threaded through).
  - `async function pullFromRepo(workspaceId: string, repoLink: { owner: string; repo: string; branch: string }, lastSyncedAt: Record<string, number>): Promise<{ plan: PullPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }>` — fetches the tree, resolves conflicts/deletions into a plan, applies every non-conflicting/non-deletion change immediately, and returns the plan plus a callback the conflict modal calls once the user has resolved every conflict (deletions still need confirmation even with zero conflicts — the caller checks `plan.deletions.length` itself and only needs `applyResolved({})` to proceed past an all-clear pull).

- [ ] **Step 1: Write the failing test**

Add to `client/src/repo-sync.test.ts`:

```typescript
import { planPull, type TreeEntry } from "./repo-sync";
import type { Doc } from "./types";

function fakeDoc(overrides: Partial<Doc>): Doc {
  return { id: "d1", name: "a", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}

describe("planPull", () => {
  it("creates a new doc for a tree entry with no matching repoPath", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const plan = planPull(entries, [], new Set());
    expect(plan.creates).toEqual([{ repoPath: "a.md", sha: "s1" }]);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.deletions).toEqual([]);
  });

  it("skips a doc whose SHA already matches", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const docs = [fakeDoc({ repoPath: "a.md", repoSha: "s1" })];
    const plan = planPull(entries, docs, new Set());
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("queues an update when the SHA differs and the doc has no local edits since last sync", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1" })];
    const plan = planPull(entries, docs, new Set());
    expect(plan.updates).toEqual([{ docId: "d1", repoPath: "a.md", sha: "s2" }]);
    expect(plan.conflicts).toEqual([]);
  });

  it("queues a conflict when the SHA differs and the doc has local edits since last sync", () => {
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "local edit" })];
    const plan = planPull(entries, docs, new Set(["d1"]));
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "a.md", localContent: "local edit", remoteSha: "s2" }]);
  });

  it("queues a deletion for a doc whose repoPath is no longer in the tree", () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "gone.md", repoSha: "s1" })];
    const plan = planPull([], docs, new Set());
    expect(plan.deletions).toEqual([{ docId: "d1", repoPath: "gone.md" }]);
  });

  it("ignores docs with no repoPath (never synced) entirely", () => {
    const docs = [fakeDoc({ id: "d1" })];
    const plan = planPull([], docs, new Set());
    expect(plan.deletions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `planPull`/`TreeEntry` don't exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `client/src/repo-sync.ts` (imports at the top, logic after the existing helpers):

```typescript
import type { Doc } from "./types";
import { docsInWorkspace, upsertDocFromRepo, removeDocsByRepoPaths } from "./stores/docs";

export interface TreeEntry {
  path: string;
  sha: string;
  type: "blob" | "tree";
}

function filterMarkdownEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.filter((e) => e.type === "blob" && /\.md$/i.test(e.path));
}

export interface PullConflict {
  docId: string;
  repoPath: string;
  localContent: string;
  remoteSha: string;
}

export interface PullPlan {
  creates: { repoPath: string; sha: string }[];
  updates: { docId: string; repoPath: string; sha: string }[];
  conflicts: PullConflict[];
  deletions: { docId: string; repoPath: string }[];
}

export function planPull(mdEntries: TreeEntry[], docs: Doc[], dirtyDocIds: Set<string>): PullPlan {
  const plan: PullPlan = { creates: [], updates: [], conflicts: [], deletions: [] };
  const byPath = new Map(docs.filter((d) => d.repoPath).map((d) => [d.repoPath!, d]));
  const seenPaths = new Set<string>();

  for (const entry of filterMarkdownEntries(mdEntries)) {
    seenPaths.add(entry.path);
    const doc = byPath.get(entry.path);
    if (!doc) {
      plan.creates.push({ repoPath: entry.path, sha: entry.sha });
    } else if (doc.repoSha === entry.sha) {
      continue;
    } else if (dirtyDocIds.has(doc.id)) {
      plan.conflicts.push({ docId: doc.id, repoPath: entry.path, localContent: doc.content, remoteSha: entry.sha });
    } else {
      plan.updates.push({ docId: doc.id, repoPath: entry.path, sha: entry.sha });
    }
  }

  for (const doc of docs) {
    if (doc.repoPath && !seenPaths.has(doc.repoPath)) plan.deletions.push({ docId: doc.id, repoPath: doc.repoPath });
  }

  return plan;
}

export async function pullFromRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  dirtyDocIds: Set<string>
): Promise<{ plan: PullPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = planPull(entries, docs, dirtyDocIds);

  const docSlugFor = (repoPath: string) => repoPath.replace(/\.md$/i, "").split("/").pop() || "untitled";

  async function fetchAndApply(repoPath: string, sha: string, existingDocId: string | null): Promise<void> {
    const blobRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/blob/${sha}`);
    if (!blobRes.ok) throw new Error(`Couldn't read ${repoPath}: HTTP ${blobRes.status}`);
    const blobData = await blobRes.json();
    const rawContent = blobData.encoding === "base64" ? atob(blobData.content.replace(/\n/g, "")) : blobData.content;
    const docSlug = docSlugFor(repoPath);

    const imageRefs = [...rawContent.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map((m) => m[1] as string);
    const blobs: Record<string, string> = {};
    for (const assetPath of imageRefs) {
      const assetEntry = entries.find((e) => e.path === assetPath);
      if (!assetEntry) continue;
      const assetRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/blob/${assetEntry.sha}`);
      if (!assetRes.ok) continue;
      const assetData = await assetRes.json();
      blobs[assetPath] = `data:image/*;base64,${assetData.content.replace(/\n/g, "")}`;
    }

    // resolveImagesFromPull is defined earlier in this same file (Task 9)
    // — called directly, no import needed.
    const resolved = resolveImagesFromPull(rawContent, docSlug, blobs);
    upsertDocFromRepo(workspaceId, repoPath, { name: docSlug, content: resolved.content, images: Object.keys(resolved.images).length ? resolved.images : undefined, repoSha: sha });
    void existingDocId;
  }

  for (const create of plan.creates) await fetchAndApply(create.repoPath, create.sha, null);
  for (const update of plan.updates) await fetchAndApply(update.repoPath, update.sha, update.docId);
  removeDocsByRepoPaths(workspaceId, plan.deletions.map((d) => d.repoPath));

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    for (const conflict of plan.conflicts) {
      if (resolutions[conflict.docId] === "theirs") await fetchAndApply(conflict.repoPath, conflict.remoteSha, conflict.docId);
    }
  }

  return { plan, applyResolved };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: add repo-sync pull planner and orchestration"
```

---

### Task 11: Push planner + orchestration

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `TreeEntry`, `rewriteImagesForPush`, `slugifyDocName`, `dedupeRepoPath` (Task 9/this file); `docsInWorkspace`, `setDocRepoLinkById` (`./stores/docs`, Task 8).
- Produces:
  - `interface PushConflict { docId: string; repoPath: string; remoteSha: string }`
  - `interface PushPlan { changes: { docId: string; repoPath: string; content: string; assets: ImageAsset[] }[]; deletions: string[]; conflicts: PushConflict[] }`
  - `planPush(docs: Doc[], mdEntries: TreeEntry[]): PushPlan` — pure. For each doc in `docs`: assigns a `repoPath` (slugified + deduped against `mdEntries` paths) if it has none yet; compares the doc's own pushable content — for the SHA comparison it uses `doc.repoSha` against the *current* `mdEntries` sha at that path (if the doc already has a `repoPath`) — a mismatch means someone else changed the file since this doc's last sync → conflict. A `repoPath` present in `mdEntries` but belonging to no doc in `docs` is not this function's concern (that's a pull-side "someone added a file on GitHub" case, out of scope for push). Docs that exist locally with a `repoPath` no longer needed... no such case exists for push (deletions come from `docsInWorkspace` no longer containing a doc that used to have a `repoPath` — that requires the *previous* doc list, which `planPush` doesn't have; see the orchestration function below, which tracks deletions itself by diffing against `mdEntries` paths it recognizes as ones this workspace previously owned).
  - `async function pushToRepo(workspaceId: string, repoLink: { owner: string; repo: string; branch: string }): Promise<{ plan: PushPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }>`.

- [ ] **Step 1: Write the failing test**

Add to `client/src/repo-sync.test.ts`:

```typescript
import { planPush } from "./repo-sync";

describe("planPush", () => {
  it("assigns a new repoPath to a doc that has never synced", () => {
    const docs = [fakeDoc({ id: "d1", name: "My Notes", repoPath: undefined })];
    const plan = planPush(docs, []);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("my-notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("dedupes a new repoPath against the current tree", () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = planPush(docs, entries);
    expect(plan.changes[0]!.repoPath).toBe("notes-2.md");
  });

  it("skips a doc whose repoSha still matches the tree", () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "unchanged" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const plan = planPush(docs, entries);
    expect(plan.changes).toEqual([]);
  });

  it("queues a conflict when the tree's sha differs from the doc's last-known repoSha", () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const plan = planPush(docs, entries);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "a.md", remoteSha: "s2" }]);
  });

  it("pushes a doc whose repoPath is not in the tree at all yet (first push after linking)", () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "hi" })];
    const plan = planPush(docs, []);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("a.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `planPush` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `client/src/repo-sync.ts` (after `planPull`/`pullFromRepo`):

```typescript
export interface PushConflict {
  docId: string;
  repoPath: string;
  remoteSha: string;
}

export interface PushPlan {
  changes: { docId: string; repoPath: string; content: string; assets: ImageAsset[] }[];
  deletions: string[];
  conflicts: PushConflict[];
}

export function planPush(docs: Doc[], mdEntries: TreeEntry[]): PushPlan {
  const plan: PushPlan = { changes: [], deletions: [], conflicts: [] };
  const treeShaByPath = new Map(mdEntries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const usedPaths = new Set(mdEntries.map((e) => e.path));

  for (const doc of docs) {
    let repoPath = doc.repoPath;
    if (!repoPath) {
      const base = `${slugifyDocName(doc.name)}.md`;
      repoPath = dedupeRepoPath(base, usedPaths);
      usedPaths.add(repoPath);
    } else {
      const treeSha = treeShaByPath.get(repoPath);
      if (treeSha !== undefined && treeSha !== doc.repoSha) {
        plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeSha });
        continue;
      }
    }
    const { content, assets } = rewriteImagesForPush(doc.content, slugifyDocName(doc.name), doc.images, doc.diagrams);
    plan.changes.push({ docId: doc.id, repoPath, content, assets });
  }

  return plan;
}

function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

function dataUrlToBase64(dataUrl: string): string {
  const match = dataUrl.match(/^data:[^;]+;base64,(.*)$/);
  return match ? match[1]! : "";
}

export async function pushToRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<{ plan: PushPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = planPush(docs, entries);

  async function sendChanges(changes: PushPlan["changes"]): Promise<void> {
    if (changes.length === 0) return;
    const blobs: { path: string; contentBase64: string }[] = [];
    for (const change of changes) {
      blobs.push({ path: change.repoPath, contentBase64: toBase64(change.content) });
      for (const asset of change.assets) blobs.push({ path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl) });
    }
    // Fetched fresh here, not reused from `entries` above (which was read
    // for planning and could be stale by the time a push actually goes
    // out) — matches the spec's "fetch the current tree fresh" push step.
    // handleRepoTree's response carries both the tree sha (base_tree for
    // the new tree) and the branch's commit sha (parents[0] for the new
    // commit) — see Task 3's comment for why those are two different
    // values and both are needed.
    const branchRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
    const branchTree = await branchRes.json();
    const pushRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch: repoLink.branch,
        baseTreeSha: branchTree.treeSha,
        parentCommitSha: branchTree.commitSha,
        blobs,
        deletePaths: [],
      }),
    });
    if (pushRes.status === 409) throw new Error("The repo changed since this push started — pull first, then try again.");
    if (!pushRes.ok) throw new Error(`Push failed: HTTP ${pushRes.status}`);
    const pushData = await pushRes.json();
    for (const change of changes) {
      // Every asset's path was included in the same `blobs` array sent
      // above, so its new sha comes back under its own path key in
      // pushData.blobShas alongside the doc's own — no second round trip
      // needed to learn the pushed images' SHAs.
      const repoImageShas = Object.fromEntries(change.assets.map((a) => [a.path, pushData.blobShas[a.path]]));
      setDocRepoLinkById(change.docId, change.repoPath, pushData.blobShas[change.repoPath], change.assets.length ? repoImageShas : undefined);
    }
  }

  await sendChanges(plan.changes);

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const winningDocs = plan.conflicts.filter((c) => resolutions[c.docId] === "mine").map((c) => docs.find((d) => d.id === c.docId)!);
    const retryPlan = planPush(winningDocs, []);
    await sendChanges(retryPlan.changes);
  }

  return { plan, applyResolved };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p client/tsconfig.json`
Expected: all pass, clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: add repo-sync push planner and orchestration"
```

---

### Task 12: Repo-link modal

**Files:**
- Create: `client/src/stores/repoSync.ts`
- Create: `client/src/components/RepoLinkModal.svelte`
- Modify: `client/index.html` (add mount div), `client/src/main.ts` (mount the component)

**Interfaces:**
- Consumes: `githubUsername` store (`./stores/github`), `Modal.svelte`/`Toggletip.svelte` (existing components), `activeWorkspaceIdStore`, `workspacesStore` (`./stores/workspaces`), `setWorkspaceRepoLink` (Task 7), `showToast` (`./stores/toast`).
- Produces: `repoLinkModalOpen: Writable<boolean>` (in the new store file), `openRepoLinkModal()` bridge method wiring (Task 14 wires the actual `window.MDE.openRepoLinkModal` call site; this task's modal just reacts to the store).

- [ ] **Step 1: Create the presentational store**

Create `client/src/stores/repoSync.ts`:

```typescript
// Presentational state for RepoLinkModal.svelte and RepoConflictModal.svelte
// — mirrors stores/openGistModal.ts (a single open flag) and stores/gist.ts
// (a busy-label string) for the same reasons those exist: the modals need
// reactive state a plain module-level variable can't give Svelte, and
// nothing else in the app needs to reach into their internals.
import { writable } from "svelte/store";

export const repoLinkModalOpen = writable(false);
export const repoSyncBusyLabel = writable<string | null>(null);
```

- [ ] **Step 2: Create the modal component**

Create `client/src/components/RepoLinkModal.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { repoLinkModalOpen } from "../stores/repoSync";
  import { githubUsername } from "../stores/github";
  import { activeWorkspaceIdStore } from "../stores/workspaces";
  import { setWorkspaceRepoLink } from "../stores/workspaces";
  import { showToast } from "../stores/toast";

  let repos = $state<any[]>([]);
  let listTitle = $state("");
  let listHint = $state("Sign in with GitHub to see your own repos here.");
  let manualInput = $state("");
  let newRepoName = $state("");
  let newRepoPrivate = $state(true);
  let busyKey = $state<string | null>(null);
  const CREATE_KEY = "__create__";
  const MANUAL_KEY = "__manual__";

  function close() {
    repoLinkModalOpen.set(false);
  }

  async function loadRepoList() {
    if (!$githubUsername) {
      listTitle = "Sign in required";
      listHint = "Sign in with GitHub to see your own repos here.";
      repos = [];
      return;
    }
    listTitle = "Loading…";
    listHint = "Loading your repos…";
    try {
      const res = await fetch("/api/repo/list");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      repos = await res.json();
      listTitle = repos.length === 0 ? "No repos" : "";
      listHint = repos.length === 0 ? "No repos found." : "";
    } catch {
      listTitle = "Error";
      listHint = "Couldn't load your repos.";
      repos = [];
    }
  }

  function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    setWorkspaceRepoLink(workspaceId, { owner, repo, branch });
    close();
    showToast(`Linked to ${owner}/${repo}`, "success");
  }

  async function link(fullName: string, defaultBranch: string, key: string) {
    busyKey = key;
    try {
      const [owner, repo] = fullName.split("/");
      linkWorkspace(owner!, repo!, defaultBranch);
    } finally {
      busyKey = null;
    }
  }

  function linkFromManualInput() {
    const trimmed = manualInput.trim().replace(/^https?:\/\/github\.com\//, "");
    const [owner, repo] = trimmed.split("/");
    if (!owner || !repo) {
      showToast("Enter a repo as owner/repo", "error");
      return;
    }
    linkWorkspace(owner, repo.replace(/\.git$/, ""), "main");
  }

  async function createAndLink() {
    const name = newRepoName.trim();
    if (!name) return;
    busyKey = CREATE_KEY;
    try {
      const res = await fetch("/api/repo/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, private: newRepoPrivate }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const [owner, repo] = data.full_name.split("/");
      linkWorkspace(owner, repo, data.default_branch || "main");
    } catch {
      showToast("Couldn't create the repo", "error");
    } finally {
      busyKey = null;
    }
  }

  $effect(() => {
    if ($repoLinkModalOpen) {
      manualInput = "";
      newRepoName = "";
      void loadRepoList();
    }
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $repoLinkModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $repoLinkModalOpen}
  <Modal title="Link Workspace to GitHub Repo" icon="icon-github" wide labelledBy="repoLinkModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Every .md file in the repo's tree becomes a doc in this workspace. Pick an existing repo, paste one, or create a new one.</Toggletip>
    {/snippet}

    <label class="modal-field">
      <span>owner/repo</span>
      <div class="share-row">
        <input type="text" placeholder="owner/repo or a GitHub URL" aria-label="owner/repo" bind:value={manualInput} onkeydown={(e) => e.key === "Enter" && linkFromManualInput()} />
        <button class="secondary-btn" type="button" disabled={busyKey === MANUAL_KEY} onclick={linkFromManualInput}>Link</button>
      </div>
    </label>

    <div class="menu-divider"></div>
    <div class="menu-section-label">Create a new repo</div>
    <div class="share-row">
      <input type="text" placeholder="Repo name" aria-label="New repo name" bind:value={newRepoName} onkeydown={(e) => e.key === "Enter" && createAndLink()} />
      <label><input type="checkbox" bind:checked={newRepoPrivate} /> Private</label>
      <button class="secondary-btn" type="button" disabled={busyKey === CREATE_KEY || !newRepoName.trim()} onclick={createAndLink}>
        {busyKey === CREATE_KEY ? "Creating…" : "Create & Link"}
      </button>
    </div>

    <div class="menu-divider"></div>
    <div class="menu-section-label">Your Repos</div>
    {#if listHint}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-github"></use></svg>
        <div class="empty-state-title">{listTitle}</div>
        <div class="empty-state-desc">{listHint}</div>
        {#if !$githubUsername}
          <button type="button" class="primary-btn" onclick={() => window.MDE.openGithubSignInPopup()} style="margin-top: 8px;">
            <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
          </button>
        {/if}
      </div>
    {/if}
    <div class="images-list">
      {#each repos as repo (repo.full_name)}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{repo.full_name}</div>
            <div class="gist-date">{repo.private ? "Private" : "Public"}</div>
          </div>
          <button class="secondary-btn" type="button" disabled={busyKey === repo.full_name} onclick={() => link(repo.full_name, repo.default_branch, repo.full_name)}>
            {busyKey === repo.full_name ? "Linking…" : "Link"}
          </button>
        </div>
      {/each}
    </div>
  </Modal>
{/if}
```

- [ ] **Step 3: Add the mount point**

In `client/index.html`, add near the other modal mount divs (find `<div id="open-gist-modal-mount"></div>` and add right after it):

```html
    <div id="repo-link-modal-mount"></div>
```

In `client/src/main.ts`, add the import (near the `OpenGistModal` import) and mount call (near the `mount(OpenGistModal, ...)` line):

```typescript
import RepoLinkModal from "./components/RepoLinkModal.svelte";
```

```typescript
mount(RepoLinkModal, { target: document.getElementById("repo-link-modal-mount")! });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Manual verification**

Run `npm run dev` (or the project's existing dev-server command), open the app, confirm no console errors on load (the modal renders nothing when its store is `false`, so this only checks it mounts cleanly).

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/repoSync.ts client/src/components/RepoLinkModal.svelte client/index.html client/src/main.ts
git commit -m "feat: add repo-link modal"
```

---

### Task 13: Conflict/deletion resolution modal

**Files:**
- Create: `client/src/components/RepoConflictModal.svelte`
- Modify: `client/src/stores/repoSync.ts`, `client/index.html`, `client/src/main.ts`

**Interfaces:**
- Consumes: `PullConflict`/`PushConflict` types, `pullFromRepo`/`pushToRepo`'s `applyResolved` callback shape (Tasks 10-11).
- Produces: `repoConflictModalOpen: Writable<boolean>`, `repoConflictState: Writable<{ kind: "pull" | "push"; conflicts: { docId: string; repoPath: string }[]; deletions: { docId: string; repoPath: string }[]; onResolve: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> } | null>` (in `stores/repoSync.ts`) — Task 14's orchestration wiring sets this after calling `pullFromRepo`/`pushToRepo`, whenever `plan.conflicts.length > 0 || plan.deletions.length > 0`.

- [ ] **Step 1: Extend the store**

Add to `client/src/stores/repoSync.ts`:

```typescript
export interface RepoConflictState {
  kind: "pull" | "push";
  conflicts: { docId: string; docName: string; repoPath: string }[];
  deletions: { docId: string; docName: string; repoPath: string }[];
  onResolve: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
}

export const repoConflictModalOpen = writable(false);
export const repoConflictState = writable<RepoConflictState | null>(null);
```

- [ ] **Step 2: Create the modal component**

Create `client/src/components/RepoConflictModal.svelte`:

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import { repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { showToast } from "../stores/toast";

  let choices = $state<Record<string, "mine" | "theirs">>({});
  let busy = $state(false);

  $effect(() => {
    if ($repoConflictState) {
      choices = Object.fromEntries($repoConflictState.conflicts.map((c) => [c.docId, "mine" as const]));
    }
  });

  function close() {
    repoConflictModalOpen.set(false);
    repoConflictState.set(null);
  }

  async function confirm() {
    const state = $repoConflictState;
    if (!state) return;
    busy = true;
    try {
      await state.onResolve(choices);
      showToast(state.kind === "pull" ? "Pull complete" : "Push complete", "success");
      close();
    } catch (err: any) {
      showToast(err.message || "Failed to resolve conflicts", "error");
    } finally {
      busy = false;
    }
  }
</script>

{#if $repoConflictModalOpen && $repoConflictState}
  <Modal title={$repoConflictState.kind === "pull" ? "Resolve Pull Conflicts" : "Resolve Push Conflicts"} icon="icon-github" wide labelledBy="repoConflictModalTitle" onClose={close}>
    {#if $repoConflictState.conflicts.length > 0}
      <div class="menu-section-label">Changed on both sides</div>
      {#each $repoConflictState.conflicts as conflict (conflict.docId)}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{conflict.docName}</div>
            <div class="gist-date">{conflict.repoPath}</div>
          </div>
          <select bind:value={choices[conflict.docId]} aria-label={`Resolution for ${conflict.docName}`}>
            <option value="mine">Keep mine</option>
            <option value="theirs">Take theirs</option>
          </select>
        </div>
      {/each}
    {/if}
    {#if $repoConflictState.deletions.length > 0}
      <div class="menu-section-label">Will be removed</div>
      {#each $repoConflictState.deletions as del (del.docId)}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{del.docName}</div>
            <div class="gist-date">{del.repoPath}</div>
          </div>
        </div>
      {/each}
    {/if}
    <div class="modal-actions">
      <button class="secondary-btn" type="button" onclick={close} disabled={busy}>Cancel</button>
      <button class="primary-btn" type="button" onclick={confirm} disabled={busy}>{busy ? "Applying…" : "Apply"}</button>
    </div>
  </Modal>
{/if}
```

- [ ] **Step 3: Add the mount point**

In `client/index.html`, add after the `repo-link-modal-mount` div added in Task 12:

```html
    <div id="repo-conflict-modal-mount"></div>
```

In `client/src/main.ts`, add the import and mount call alongside `RepoLinkModal`'s:

```typescript
import RepoConflictModal from "./components/RepoConflictModal.svelte";
```

```typescript
mount(RepoConflictModal, { target: document.getElementById("repo-conflict-modal-mount")! });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/repoSync.ts client/src/components/RepoConflictModal.svelte client/index.html client/src/main.ts
git commit -m "feat: add repo conflict/deletion resolution modal"
```

---

### Task 14: File-menu wiring

**Files:**
- Modify: `client/src/types.ts` (MDEBridge), `client/src/repo-sync.ts`, `client/src/components/MenuBar.svelte`
- Create: `client/src/repo-sync-ui.ts`

**Interfaces:**
- Consumes: `pullFromRepo`, `pushToRepo` (Tasks 10-11), `repoLinkModalOpen`, `repoConflictModalOpen`, `repoConflictState` (Tasks 12-13), `activeWorkspaceIdStore`, `workspacesStore`, `clearWorkspaceRepoLink` (`./stores/workspaces`), `docsInWorkspace` (`./stores/docs`).
- Produces: `MDEBridge` gains `openRepoLinkModal?(): void; pushToRepoAction?(): void; pullFromRepoAction?(): void; unlinkRepo?(): void;` — window.MDE bridge methods, wired at module load time in the new `repo-sync-ui.ts` module (mirrors `gist.ts`'s top-level `window.MDE.publishGist = publish;` pattern), which MenuBar.svelte calls through, matching how it calls `window.MDE.publishGist?.()`.

- [ ] **Step 1: Add MDEBridge methods**

In `client/src/types.ts`, add to the `MDEBridge` interface (near `publishGist?`/`openGistPicker?`, at the end of the interface):

```typescript
  openRepoLinkModal?(): void;
  pushToRepoAction?(): void;
  pullFromRepoAction?(): void;
  unlinkRepo?(): void;
```

- [ ] **Step 2: Create the UI-wiring module**

Create `client/src/repo-sync-ui.ts`:

```typescript
// Wires repo-sync's orchestration functions (repo-sync.ts) to window.MDE,
// the same way gist.ts wires publish()/openGistPicker() — MenuBar.svelte
// has no direct import of feature modules, only window.MDE and stores.
import { activeWorkspaceIdStore, workspacesStore, clearWorkspaceRepoLink } from "./stores/workspaces";
import { docsInWorkspace } from "./stores/docs";
import { pullFromRepo, pushToRepo, type PullConflict, type PushConflict } from "./repo-sync";
import { repoLinkModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
import { showToast } from "./stores/toast";
import { get } from "svelte/store";

// The "gist" scope this app requested before this feature shipped can't
// read/write repos — a user signed in under that older grant needs to
// re-authorize under the new "repo" scope before any repo-sync action
// will work. Checked fresh on every action rather than cached, since the
// grant can also be revoked entirely from GitHub's side at any time.
async function hasRepoScope(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/github/me");
    const data = await res.json();
    return Array.isArray(data.scopes) && data.scopes.includes("repo");
  } catch (err) {
    return false;
  }
}

async function requireRepoScope(): Promise<boolean> {
  if (await hasRepoScope()) return true;
  window.MDE.requireGithubSignIn("GitHub repo sync needs a fresh sign-in to grant repo access. Sign in to continue.");
  return false;
}

window.MDE.openRepoLinkModal = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    repoLinkModalOpen.set(true);
  })();
};

window.MDE.unlinkRepo = () => {
  const workspaceId = get(activeWorkspaceIdStore);
  if (workspaceId) clearWorkspaceRepoLink(workspaceId);
};

function activeRepoLink() {
  const workspaceId = get(activeWorkspaceIdStore);
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  return workspaceId && ws?.repoLink ? { workspaceId, repoLink: ws.repoLink } : null;
}

function docNameFor(workspaceId: string, docId: string): string {
  return docsInWorkspace(workspaceId).find((d) => d.id === docId)?.name || "Untitled";
}

window.MDE.pullFromRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pulling…");
  try {
    // No local dirty-tracking timestamp exists yet at this call site —
    // pass an empty set, meaning "treat every doc as clean," which is
    // conservative in the wrong direction (a genuinely-dirty doc could
    // get silently overwritten by an update instead of flagged as a
    // conflict). Acceptable for this task since it still routes every
    // conflict planPull *can* detect through the modal; tightening this
    // to real dirty-tracking is a follow-up, not a blocker for this plan.
    const { plan, applyResolved } = await pullFromRepo(active.workspaceId, active.repoLink, new Set());
    if (plan.conflicts.length > 0 || plan.deletions.length > 0) {
      repoConflictState.set({
        kind: "pull",
        conflicts: plan.conflicts.map((c: PullConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: plan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(active.workspaceId, d.docId), repoPath: d.repoPath })),
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      showToast("Pulled from repo", "success");
    }
  } catch (err: any) {
    showToast(err.message || "Pull failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};

window.MDE.pushToRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pushing…");
  try {
    const { plan, applyResolved } = await pushToRepo(active.workspaceId, active.repoLink);
    if (plan.conflicts.length > 0) {
      repoConflictState.set({
        kind: "push",
        conflicts: plan.conflicts.map((c: PushConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: [],
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      showToast("Pushed to repo", "success");
    }
  } catch (err: any) {
    showToast(err.message || "Push failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};
```

- [ ] **Step 3: Import the wiring module**

In `client/src/main.ts`, add near the other feature-module imports (e.g. near wherever `./gist` or `./collab` gets imported for its side effects — check with `grep -n "^import \"./gist\"\|^import \"./collab\"" client/src/main.ts`, and add this line the same way):

```typescript
import "./repo-sync-ui";
```

- [ ] **Step 4: Add the File-menu submenu**

In `client/src/components/MenuBar.svelte`, add script-level imports and derived state (near the existing `hasGist`/`gistLabel` derivations):

```typescript
  import { workspacesStore, activeWorkspaceIdStore } from "../stores/workspaces";
  import { repoSyncBusyLabel } from "../stores/repoSync";

  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const hasRepoLink = $derived(!!activeWorkspace?.repoLink);
  const repoLinkLabel = $derived(activeWorkspace?.repoLink ? `${activeWorkspace.repoLink.owner}/${activeWorkspace.repoLink.repo}` : "");
```

Add a new submenu in the File menu's markup, right after the existing `<div class="menu-submenu">...From GitHub Gist...</div>` block (same nesting level, inside the File dropdown panel):

```svelte
      <div class="menu-submenu">
        <button class="menu-submenu-trigger" type="button">
          <svg class="icon"><use href="#icon-github"></use></svg> GitHub Repo <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          {#if !hasRepoLink}
            <button type="button" onclick={() => act(() => window.MDE.openRepoLinkModal?.())}>
              <svg class="icon"><use href="#icon-github"></use></svg> Link Workspace to Repo...
            </button>
          {:else}
            <div class="menu-section-label">{repoLinkLabel}</div>
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pullFromRepoAction?.())}>
              <svg class="icon"><use href="#icon-download"></use></svg> {$repoSyncBusyLabel === "Pulling…" ? "Pulling…" : "Pull from Repo"}
            </button>
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pushToRepoAction?.())}>
              <svg class="icon"><use href="#icon-upload"></use></svg> {$repoSyncBusyLabel === "Pushing…" ? "Pushing…" : "Push to Repo"}
            </button>
            <button type="button" onclick={() => act(() => window.MDE.unlinkRepo?.())}>
              <svg class="icon"><use href="#icon-x"></use></svg> Unlink Repo
            </button>
          {/if}
        </div>
      </div>
```

`icon-download`, `icon-upload`, and `icon-x` all already exist in `client/index.html`'s icon sprite (confirmed by grepping its `<symbol id="icon-...">` definitions) — no new SVG symbols needed.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Manual verification**

Run the dev server, open File menu, confirm "GitHub Repo" submenu appears with "Link Workspace to Repo..." (no workspace linked yet), and clicking it opens the RepoLinkModal from Task 12.

- [ ] **Step 7: Commit**

```bash
git add client/src/types.ts client/src/repo-sync-ui.ts client/src/main.ts client/src/components/MenuBar.svelte
git commit -m "feat: wire repo sync into the File menu"
```

---

### Task 15: Manual E2E test script

**Files:**
- Create: `scripts/manual-testing/repo-sync-e2e.mjs`
- Modify: `scripts/manual-testing/README.md`

**Interfaces:**
- Consumes: the existing `scripts/manual-testing/dev-login.patch`/`enable-dev-login.sh` tooling (already documented in the README), Playwright (`npx playwright`, already a devDependency per prior manual-testing scripts in this directory).

- [ ] **Step 1: Write the script**

Create `scripts/manual-testing/repo-sync-e2e.mjs`:

```javascript
// Manual E2E for GitHub repo sync — requires a REAL GitHub repo you can
// push test commits to (this creates and deletes files in it) and a real
// GitHub OAuth session (the dev-login route only fakes the app's own
// session cookie; it does not fake a GitHub API token, so repo-sync calls
// still need a real signed-in browser session — sign in through the
// actual GitHub OAuth popup when the script pauses for it).
//
// Usage: node scripts/manual-testing/repo-sync-e2e.mjs <owner>/<repo> [url]
import { chromium } from "playwright";

const [ownerRepo, url = "http://localhost:8787"] = process.argv.slice(2);
if (!ownerRepo || !ownerRepo.includes("/")) {
  console.error("Usage: node repo-sync-e2e.mjs <owner>/<repo> [url]");
  process.exit(1);
}
const [owner, repo] = ownerRepo.split("/");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

  await page.goto(url);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.newDoc === "function", { timeout: 15000 });
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();

  console.log("Sign in with GitHub in the opened window if prompted, then press Enter here to continue.");
  await new Promise((resolve) => process.stdin.once("data", resolve));

  await page.evaluate(() => window.MDE.setView("split"));
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible", timeout: 15000 });
  await page.evaluate((text) => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });
  }, "# Test doc\n\nCreated by repo-sync-e2e.mjs.");

  await page.evaluate(() => window.MDE.openRepoLinkModal?.());
  await page.waitForSelector('input[aria-label="owner/repo"]', { state: "visible", timeout: 5000 });
  await page.fill('input[aria-label="owner/repo"]', `${owner}/${repo}`);
  await page.click('input[aria-label="owner/repo"] ~ button');
  console.log(`Linked to ${owner}/${repo}. Pushing...`);

  await page.evaluate(() => window.MDE.pushToRepoAction?.());
  await page.waitForTimeout(2000);
  console.log(`Check https://github.com/${owner}/${repo}/commits to verify a new commit landed.`);

  await browser.close();
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Update the README**

In `scripts/manual-testing/README.md`, add a new section (following the existing format for the other scripts documented there):

```markdown
### `repo-sync-e2e.mjs`

Manual, interactive E2E for GitHub repo sync. Requires a real disposable
test repo you're OK pushing test commits to, and a real GitHub OAuth
sign-in (this script pauses and waits for you to sign in through the
actual popup — repo-sync calls need a real GitHub API token, which the
dev-login route's fake session cookie does not provide).

```bash
node scripts/manual-testing/repo-sync-e2e.mjs <your-username>/<test-repo>
```

Creates a doc, links the active workspace to the given repo, pushes, and
prints the commits URL to verify by hand.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/manual-testing/repo-sync-e2e.mjs scripts/manual-testing/README.md
git commit -m "test: add manual E2E script for repo sync"
```

---

## Final Verification

After all tasks complete:

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
npm run build
```

Expected: all tests pass, both typechecks clean, build succeeds.
