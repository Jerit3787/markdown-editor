# Link Existing Workspace Push+Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linking an existing workspace to a GitHub repo should immediately push the workspace's local docs out and pull in whatever the repo already has, instead of leaving the user to manually run Push/Pull afterward.

**Architecture:** A new `linkWorkspaceAndSync()` orchestrator in `client/src/repo-sync.ts` clears any stale repo-sync metadata on the workspace's docs, then runs the existing `pushToRepo`/`pullFromRepo` functions back to back, unmodified. Because client and server code live in two TypeScript programs with incompatible global type environments (browser DOM types vs. Cloudflare Workers types — verified directly, see Global Constraints), the new automated tests for this exercise real, stateful, local HTTP servers on each side of the network boundary separately: a shared `fake-github-server.ts` simulates GitHub's Git Data API for the server-side test, and a client-side `fake-repo-backend.ts` (built on top of the same shared fake) simulates the app's own `/api/repo/*` contract for the client-side test.

**Tech Stack:** TypeScript, Svelte 5, Vitest, Node's built-in `http`/`crypto` modules (via a new `@types/node` dev dependency).

## Global Constraints

- `linkWorkspaceAndSync` must clear every doc's `repoPath`/`repoSha`/`repoImageShas` in the target workspace *before* pushing — an already-linked-then-unlinked workspace must never compare against a previous repo's stale SHAs. This is the single most important correctness property of this feature; every task that touches it must preserve it.
- No changes to `createWorkspaceFromRepo` (the "Open repo as new workspace" flow) — out of scope, unaffected by this work.
- **Verified constraint, not a design preference:** a client file (anything under `client/src/`, checked by `client/tsconfig.json`, which has `"types": []` and DOM lib) must never statically import anything that transitively pulls in `src/env.ts`'s `Env` type (needs `@cloudflare/workers-types`' `DurableObjectNamespace`/`Fetcher`) — this breaks `npx tsc --noEmit -p client/tsconfig.json`. The reverse also breaks: adding `@cloudflare/workers-types` to client's `types` array fixes that but poisons unrelated files across the whole client codebase (confirmed: breaks `mermaid-preview.test.ts`, `repo-sync.ts`, `repo-sync-ui.ts`, `version-preview.ts` with unrelated type errors, because workers-types' ambient globals redefine `Response`/`fetch` incompatibly with DOM lib). Root `src/` files must likewise never import anything requiring DOM lib globals (`localStorage`, `HTMLElement`, `indexedDB`, etc.) — confirmed the same way in the other direction. Every task below that adds a file respects this boundary; do not "simplify" by crossing it.
- Files under `src/test-support/` and `client/src/test-support/` may use `node:http`/`node:crypto` (via `@types/node`, added in Task 1) but must never import Cloudflare-Worker-specific types (`Env`, anything from `src/github-repo.ts`/`src/auth.ts`) if they're meant to be importable from `client/src/` — this is what keeps `fake-github-server.ts` shareable across both sides.
- Blob SHAs in the fake GitHub server must be computed with git's real blob-hashing algorithm (`sha1("blob " + byteLength + "\0" + content)`) — same as `client/src/repo-sync.ts`'s existing `gitBlobSha` helper — so pushed content's SHA is independently verifiable, not a placeholder value.
- No new runtime dependency — `@types/node` is a dev-only, types-only package with zero bundle/runtime impact.

---

### Task 1: Fake GitHub server (shared test harness)

**Files:**
- Modify: `package.json`, `package-lock.json` (add `@types/node` devDependency)
- Modify: `client/tsconfig.json` (add `"node"` to `types`)
- Modify: `tsconfig.json` (add `"node"` to `types`, alongside the existing `@cloudflare/workers-types`)
- Create: `src/test-support/fake-github-server.ts`
- Test: `src/test-support/fake-github-server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FakeTreeEntry {
    path: string;
    sha: string;
    type: "blob" | "tree";
  }
  export interface FakeGithubServer {
    baseUrl: string; // e.g. "http://127.0.0.1:54231"
    seedRepo(owner: string, repo: string, branch: string, files: { path: string; content: string }[]): void;
    stop(): Promise<void>;
  }
  export function startFakeGithubServer(): Promise<FakeGithubServer>;
  ```

- [ ] **Step 1: Add the `@types/node` dev dependency**

Run:
```bash
npm install --save-dev @types/node
```

- [ ] **Step 2: Update both tsconfigs' `types` arrays**

In `client/tsconfig.json`, change:
```json
    "types": []
```
to:
```json
    "types": ["node"]
```

In `tsconfig.json` (repo root), change:
```json
    "types": ["@cloudflare/workers-types"],
```
to:
```json
    "types": ["@cloudflare/workers-types", "node"],
```

- [ ] **Step 3: Verify both typechecks still pass cleanly**

Run:
```bash
npx tsc --noEmit -p client/tsconfig.json
npx tsc --noEmit -p tsconfig.json
```
Expected: both exit clean (no errors) — this confirms adding `node` types didn't disturb anything before any new code depends on it.

- [ ] **Step 4: Write the failing test**

Create `src/test-support/fake-github-server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startFakeGithubServer, type FakeGithubServer } from "./fake-github-server";

describe("fake-github-server", () => {
  let server: FakeGithubServer;

  beforeEach(async () => {
    server = await startFakeGithubServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("seedRepo makes the seeded file visible via ref+tree lookup", async () => {
    server.seedRepo("alice", "notes", "main", [{ path: "a.md", content: "hello" }]);
    const refRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`);
    expect(refRes.status).toBe(200);
    const refData = (await refRes.json()) as { object: { sha: string } };
    const treeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees/${refData.object.sha}?recursive=1`);
    expect(treeRes.status).toBe(200);
    const treeData = (await treeRes.json()) as { tree: { path: string }[] };
    expect(treeData.tree.map((e) => e.path)).toEqual(["a.md"]);
  });

  it("computes the real git blob sha1 for pushed content", async () => {
    const res = await fetch(`${server.baseUrl}/repos/alice/notes/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: "", encoding: "base64" }),
    });
    const data = (await res.json()) as { sha: string };
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    // (same reference value already used in client/src/repo-sync.test.ts)
    expect(data.sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("a full blob-tree-commit-ref push sequence updates what a later tree fetch returns, alongside pre-existing content", async () => {
    server.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "old" }]);
    const refRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`);
    const { object } = (await refRes.json()) as { object: { sha: string } };
    const parentCommitSha = object.sha;
    const treeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees/${parentCommitSha}?recursive=1`);
    const { sha: baseTreeSha } = (await treeRes.json()) as { sha: string };

    const blobRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: Buffer.from("new content").toString("base64"), encoding: "base64" }),
    });
    const { sha: blobSha } = (await blobRes.json()) as { sha: string };

    const newTreeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree: [{ path: "new.md", mode: "100644", type: "blob", sha: blobSha }] }),
    });
    const { sha: newTreeSha } = (await newTreeRes.json()) as { sha: string };

    const commitRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: "add new.md", tree: newTreeSha, parents: [parentCommitSha] }),
    });
    const { sha: newCommitSha } = (await commitRes.json()) as { sha: string };

    const refUpdateRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommitSha, force: false }),
    });
    expect(refUpdateRes.status).toBe(200);

    const finalTreeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees/${newCommitSha}?recursive=1`);
    const finalTree = (await finalTreeRes.json()) as { tree: { path: string }[] };
    expect(finalTree.tree.map((e) => e.path).sort()).toEqual(["existing.md", "new.md"]);
  });

  it("rejects a non-fast-forward ref update", async () => {
    server.seedRepo("alice", "notes", "main", [{ path: "a.md", content: "x" }]);
    const emptyTreeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees`, {
      method: "POST",
      body: JSON.stringify({ tree: [] }),
    });
    const { sha: emptyTreeSha } = (await emptyTreeRes.json()) as { sha: string };
    const orphanCommitRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: "orphan", tree: emptyTreeSha, parents: [] }),
    });
    const { sha: orphanCommitSha } = (await orphanCommitRes.json()) as { sha: string };

    const refUpdateRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: orphanCommitSha, force: false }),
    });
    expect(refUpdateRes.status).not.toBe(200);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/test-support/fake-github-server.test.ts`
Expected: FAIL — `./fake-github-server` doesn't exist yet.

- [ ] **Step 6: Write the implementation**

Create `src/test-support/fake-github-server.ts`:

```ts
import * as http from "node:http";
import * as crypto from "node:crypto";

export interface FakeTreeEntry {
  path: string;
  sha: string;
  type: "blob" | "tree";
}

interface RepoState {
  refs: Map<string, string>; // branch -> commit sha
  commits: Map<string, { tree: string; parents: string[] }>;
  trees: Map<string, FakeTreeEntry[]>; // tree sha -> flat entry list
  blobs: Map<string, string>; // blob sha -> base64 content
}

export interface FakeGithubServer {
  baseUrl: string;
  seedRepo(owner: string, repo: string, branch: string, files: { path: string; content: string }[]): void;
  stop(): Promise<void>;
}

function gitBlobSha(contentBytes: Buffer): string {
  const header = Buffer.from(`blob ${contentBytes.length}\0`, "utf-8");
  return crypto.createHash("sha1").update(Buffer.concat([header, contentBytes])).digest("hex");
}

function randomSha(): string {
  return crypto.randomBytes(20).toString("hex");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startFakeGithubServer(): Promise<FakeGithubServer> {
  const repos = new Map<string, RepoState>();

  function getRepo(owner: string, repo: string): RepoState {
    const key = `${owner}/${repo}`;
    let state = repos.get(key);
    if (!state) {
      state = { refs: new Map(), commits: new Map(), trees: new Map(), blobs: new Map() };
      repos.set(key, state);
    }
    return state;
  }

  function resolveTreeEntries(state: RepoState, sha: string): FakeTreeEntry[] | undefined {
    const commit = state.commits.get(sha);
    if (commit) return state.trees.get(commit.tree);
    return state.trees.get(sha);
  }

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["repos", owner, repo, "git", kind, ...]

      try {
        if (parts[0] !== "repos" || parts.length < 5 || parts[3] !== "git") {
          sendJson(res, 404, { message: "not found" });
          return;
        }
        const owner = parts[1]!;
        const repo = parts[2]!;
        const kind = parts[4]!; // "refs" | "trees" | "blobs" | "commits"
        const state = getRepo(owner, repo);

        if (req.method === "GET" && kind === "refs" && parts[5] === "heads" && parts[6]) {
          const branch = parts.slice(6).join("/");
          const sha = state.refs.get(branch);
          if (!sha) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          sendJson(res, 200, { object: { sha } });
          return;
        }

        if (req.method === "GET" && kind === "trees" && parts[5]) {
          const entries = resolveTreeEntries(state, parts[5]);
          if (!entries) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          sendJson(res, 200, { sha: parts[5], tree: entries });
          return;
        }

        if (req.method === "GET" && kind === "blobs" && parts[5]) {
          const content = state.blobs.get(parts[5]);
          if (content === undefined) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          sendJson(res, 200, { sha: parts[5], content, encoding: "base64" });
          return;
        }

        if (req.method === "POST" && kind === "blobs") {
          const body = JSON.parse(await readBody(req)) as { content: string; encoding: string };
          const contentBytes = Buffer.from(body.content, "base64");
          const sha = gitBlobSha(contentBytes);
          state.blobs.set(sha, body.content);
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "POST" && kind === "trees") {
          const body = JSON.parse(await readBody(req)) as {
            base_tree?: string;
            tree: { path: string; mode: string; type: string; sha: string | null }[];
          };
          const baseEntries = body.base_tree ? resolveTreeEntries(state, body.base_tree) || [] : [];
          const byPath = new Map(baseEntries.map((e) => [e.path, e]));
          for (const entry of body.tree) {
            if (entry.sha === null) byPath.delete(entry.path);
            else byPath.set(entry.path, { path: entry.path, sha: entry.sha, type: "blob" });
          }
          const sha = randomSha();
          state.trees.set(sha, [...byPath.values()]);
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "POST" && kind === "commits") {
          const body = JSON.parse(await readBody(req)) as { message: string; tree: string; parents: string[] };
          const sha = randomSha();
          state.commits.set(sha, { tree: body.tree, parents: body.parents });
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "PATCH" && kind === "refs" && parts[5] === "heads" && parts[6]) {
          const branch = parts.slice(6).join("/");
          const body = JSON.parse(await readBody(req)) as { sha: string; force?: boolean };
          const currentSha = state.refs.get(branch);
          const newCommit = state.commits.get(body.sha);
          const isFastForward = !currentSha || (!!newCommit && newCommit.parents[0] === currentSha);
          if (!body.force && !isFastForward) {
            sendJson(res, 422, { message: "Update is not a fast forward" });
            return;
          }
          state.refs.set(branch, body.sha);
          sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } });
          return;
        }

        sendJson(res, 404, { message: "not found" });
      } catch (err) {
        sendJson(res, 500, { message: (err as Error).message });
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seedRepo(owner, repo, branch, files) {
          const state = getRepo(owner, repo);
          const entries: FakeTreeEntry[] = files.map((f) => {
            const contentBytes = Buffer.from(f.content, "utf-8");
            const sha = gitBlobSha(contentBytes);
            state.blobs.set(sha, contentBytes.toString("base64"));
            return { path: f.path, sha, type: "blob" };
          });
          const treeSha = randomSha();
          state.trees.set(treeSha, entries);
          const commitSha = randomSha();
          state.commits.set(commitSha, { tree: treeSha, parents: [] });
          state.refs.set(branch, commitSha);
        },
        stop() {
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/test-support/fake-github-server.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json client/tsconfig.json tsconfig.json src/test-support/fake-github-server.ts src/test-support/fake-github-server.test.ts
git commit -m "test: add fake GitHub server harness for repo-sync integration tests"
```

---

### Task 2: Real-sequence test for the server's push/tree handlers

**Files:**
- Modify: `src/github-repo.test.ts`

**Interfaces:**
- Consumes: `startFakeGithubServer`, `FakeGithubServer` (Task 1); `handleRepoTree`, `handleRepoPush`, `fakeEnv`, `sessionCookieHeader` (already in this file).

- [ ] **Step 1: Write the failing test**

In `src/github-repo.test.ts`, change the top import line from:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
```
to:
```ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
```

Add a new import below the existing ones:
```ts
import { startFakeGithubServer, type FakeGithubServer } from "./test-support/fake-github-server";
```

Append at the end of the file:

```ts
describe("handleRepoPush against a real fake GitHub server", () => {
  let fakeServer: FakeGithubServer;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    fakeServer = await startFakeGithubServer();
    realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const rewritten = url.startsWith("https://api.github.com") ? url.replace("https://api.github.com", fakeServer.baseUrl) : url;
      return realFetch(rewritten, init);
    });
  });

  afterEach(async () => {
    await fakeServer.stop();
  });

  it("a push lands as a real commit that a later tree fetch reflects, alongside pre-existing content", async () => {
    fakeServer.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "old content" }]);
    const cookie = await sessionCookieHeader("tok", "alice");

    const treeReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const treeRes = await handleRepoTree(treeReq, fakeEnv, "alice", "notes", "main");
    const treeData = (await treeRes.json()) as { commitSha: string; treeSha: string };

    const pushReq = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: treeData.treeSha,
        parentCommitSha: treeData.commitSha,
        blobs: [{ path: "new.md", contentBase64: Buffer.from("new content").toString("base64") }],
        deletePaths: [],
      }),
    });
    const pushRes = await handleRepoPush(pushReq, fakeEnv, "alice", "notes");
    expect(pushRes.status).toBe(200);

    const followUpReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const followUpRes = await handleRepoTree(followUpReq, fakeEnv, "alice", "notes", "main");
    const followUpData = (await followUpRes.json()) as { tree: { path: string }[] };
    expect(followUpData.tree.map((e) => e.path).sort()).toEqual(["existing.md", "new.md"]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Note: unlike most tasks in this plan, there's no red phase here — `handleRepoTree`/`handleRepoPush` are already-shipped, unmodified functions; this task only adds new test coverage exercising them against real evolving state instead of one-shot canned mocks.

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones and the new one).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/github-repo.test.ts
git commit -m "test: exercise handleRepoPush/handleRepoTree against real evolving fake-repo state"
```

---

### Task 3: `clearRepoSyncMetadata`

**Files:**
- Modify: `client/src/stores/docs.ts`
- Test: `client/src/stores/docs.test.ts`

**Interfaces:**
- Produces: `export function clearRepoSyncMetadata(workspaceId: string): void;` in `client/src/stores/docs.ts`.

- [ ] **Step 1: Write the failing test**

In `client/src/stores/docs.test.ts`, add this test inside the existing `describe("docs store — workspace integration", ...)` block, after the last existing `it(...)`:

```ts
  it("clearRepoSyncMetadata strips repoPath/repoSha/repoImageShas from every doc in the workspace, leaves other workspaces untouched", async () => {
    const { docsStore, clearRepoSyncMetadata } = await import("./docs");
    const { workspacesStore, createWorkspace } = await import("./workspaces");
    const firstWorkspaceId = get(workspacesStore)[0].id;
    const other = createWorkspace("Other");
    docsStore.set([
      {
        id: "a",
        name: "A",
        content: "",
        updatedAt: 1,
        createdAt: 1,
        workspaceId: firstWorkspaceId,
        repoPath: "a.md",
        repoSha: "sha-a",
        repoImageShas: { "img-1": "sha-img" },
      },
      { id: "b", name: "B", content: "", updatedAt: 2, createdAt: 2, workspaceId: other.id, repoPath: "b.md", repoSha: "sha-b" },
    ]);
    clearRepoSyncMetadata(firstWorkspaceId);
    const docs = get(docsStore);
    const a = docs.find((d) => d.id === "a")!;
    expect(a.repoPath).toBeUndefined();
    expect(a.repoSha).toBeUndefined();
    expect(a.repoImageShas).toBeUndefined();
    const b = docs.find((d) => d.id === "b")!;
    expect(b.repoPath).toBe("b.md");
    expect(b.repoSha).toBe("sha-b");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: FAIL — `clearRepoSyncMetadata` isn't exported yet.

- [ ] **Step 3: Write the implementation**

In `client/src/stores/docs.ts`, append after `setDocRepoLinkById` (the last function in the file):

```ts
// Called by linkWorkspaceAndSync (repo-sync.ts) whenever a workspace is
// freshly linked — a workspace previously linked to a *different* repo
// could still carry repoPath/repoSha values from that old repo, and
// comparing those stale SHAs against the new repo's tree would produce a
// false push conflict on what's really a first sync to the new repo.
export function clearRepoSyncMetadata(workspaceId: string): void {
  for (const doc of docsInWorkspace(workspaceId)) {
    updateDoc(doc.id, { repoPath: undefined, repoSha: undefined, repoImageShas: undefined });
  }
  persistDocs();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/docs.ts client/src/stores/docs.test.ts
git commit -m "feat: add clearRepoSyncMetadata to reset stale repo-sync state on relink"
```

---

### Task 4: Client-side fake repo backend

**Files:**
- Create: `client/src/test-support/fake-repo-backend.ts`
- Test: `client/src/test-support/fake-repo-backend.test.ts`

**Interfaces:**
- Consumes: `startFakeGithubServer` (Task 1, imported via `../../../src/test-support/fake-github-server`).
- Produces:
  ```ts
  export interface FakeRepoBackend {
    baseUrl: string;
    seedRepo(owner: string, repo: string, branch: string, files: { path: string; content: string }[]): void;
    stop(): Promise<void>;
  }
  export function startFakeRepoBackend(): Promise<FakeRepoBackend>;
  ```

- [ ] **Step 1: Write the failing test**

Create `client/src/test-support/fake-repo-backend.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startFakeRepoBackend, type FakeRepoBackend } from "./fake-repo-backend";

describe("fake-repo-backend", () => {
  let backend: FakeRepoBackend;

  beforeEach(async () => {
    backend = await startFakeRepoBackend();
  });

  afterEach(async () => {
    await backend.stop();
  });

  it("GET tree returns the seeded content in the shape pullFromRepo expects", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "a.md", content: "hello" }]);
    const res = await fetch(`${backend.baseUrl}/api/repo/alice/notes/tree?branch=main`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { commitSha: string; treeSha: string; tree: { path: string }[] };
    expect(data.commitSha).toBeTruthy();
    expect(data.treeSha).toBeTruthy();
    expect(data.tree.map((e) => e.path)).toEqual(["a.md"]);
  });

  it("a push lands a real commit that a following tree fetch reflects", async () => {
    backend.seedRepo("alice", "notes", "main", []);
    const treeRes = await fetch(`${backend.baseUrl}/api/repo/alice/notes/tree?branch=main`);
    const treeData = (await treeRes.json()) as { commitSha: string; treeSha: string };

    const pushRes = await fetch(`${backend.baseUrl}/api/repo/alice/notes/push`, {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: treeData.treeSha,
        parentCommitSha: treeData.commitSha,
        blobs: [{ path: "new.md", contentBase64: Buffer.from("new content").toString("base64") }],
        deletePaths: [],
      }),
    });
    expect(pushRes.status).toBe(200);
    const pushData = (await pushRes.json()) as { commitSha: string; blobShas: Record<string, string> };
    expect(pushData.blobShas["new.md"]).toBeTruthy();

    const followUpRes = await fetch(`${backend.baseUrl}/api/repo/alice/notes/tree?branch=main`);
    const followUpData = (await followUpRes.json()) as { tree: { path: string }[] };
    expect(followUpData.tree.map((e) => e.path)).toEqual(["new.md"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/test-support/fake-repo-backend.test.ts`
Expected: FAIL — `./fake-repo-backend` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `client/src/test-support/fake-repo-backend.ts`:

```ts
import * as http from "node:http";
import { startFakeGithubServer, type FakeGithubServer } from "../../../src/test-support/fake-github-server";

export interface FakeRepoBackend {
  baseUrl: string;
  seedRepo(owner: string, repo: string, branch: string, files: { path: string; content: string }[]): void;
  stop(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Duplicates the small amount of tree/blob/push proxy logic from
// src/github-repo.ts's handleRepoTree/handleRepoBlob/handleRepoPush,
// rather than importing them — a client file can never import anything
// that transitively needs the Env type (see this plan's Global
// Constraints). This mirrors github-repo.ts's own precedent of
// duplicating small integration-specific glue (its header comment
// explains it duplicates getSession/ghHeaders/safeJson from
// github-auth.ts for the same kind of independent-readability reason).
export async function startFakeRepoBackend(): Promise<FakeRepoBackend> {
  const github = await startFakeGithubServer();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "repo", owner, repo, action, ...]

    try {
      if (parts[0] !== "api" || parts[1] !== "repo" || parts.length < 5) {
        sendJson(res, 404, { message: "not found" });
        return;
      }
      const owner = parts[2]!;
      const repo = parts[3]!;
      const action = parts[4]!;
      const base = `${github.baseUrl}/repos/${owner}/${repo}`;

      if (req.method === "GET" && action === "tree") {
        const branch = url.searchParams.get("branch") || "main";
        const refRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`);
        if (!refRes.ok) {
          sendJson(res, refRes.status, await refRes.json());
          return;
        }
        const refData = (await refRes.json()) as { object: { sha: string } };
        const commitSha = refData.object.sha;
        const treeRes = await fetch(`${base}/git/trees/${commitSha}?recursive=1`);
        const treeData = (await treeRes.json()) as { sha: string; tree: unknown };
        sendJson(res, 200, { commitSha, treeSha: treeData.sha, tree: treeData.tree });
        return;
      }

      if (req.method === "GET" && action === "blob" && parts[5]) {
        const blobRes = await fetch(`${base}/git/blobs/${parts[5]}`);
        sendJson(res, blobRes.status, await blobRes.json());
        return;
      }

      if (req.method === "POST" && action === "push") {
        const body = JSON.parse(await readBody(req)) as {
          branch: string;
          baseTreeSha: string;
          parentCommitSha: string;
          blobs: { path: string; contentBase64: string }[];
          deletePaths: string[];
        };

        const blobShas: Record<string, string> = {};
        for (const blob of body.blobs) {
          const blobRes = await fetch(`${base}/git/blobs`, {
            method: "POST",
            body: JSON.stringify({ content: blob.contentBase64, encoding: "base64" }),
          });
          const data = (await blobRes.json()) as { sha: string };
          blobShas[blob.path] = data.sha;
        }

        const treeEntries = [
          ...body.blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: blobShas[b.path]! })),
          ...body.deletePaths.map((path) => ({ path, mode: "100644", type: "blob", sha: null as string | null })),
        ];
        const treeRes = await fetch(`${base}/git/trees`, {
          method: "POST",
          body: JSON.stringify({ base_tree: body.baseTreeSha, tree: treeEntries }),
        });
        const treeData = (await treeRes.json()) as { sha: string };

        const commitRes = await fetch(`${base}/git/commits`, {
          method: "POST",
          body: JSON.stringify({ message: "Update from Markdown Editor", tree: treeData.sha, parents: [body.parentCommitSha] }),
        });
        const commitData = (await commitRes.json()) as { sha: string };

        const refRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(body.branch)}`, {
          method: "PATCH",
          body: JSON.stringify({ sha: commitData.sha, force: false }),
        });
        if (!refRes.ok) {
          sendJson(res, 409, { conflict: true, message: await refRes.text() });
          return;
        }

        sendJson(res, 200, { commitSha: commitData.sha, blobShas });
        return;
      }

      sendJson(res, 404, { message: "not found" });
    } catch (err) {
      sendJson(res, 500, { message: (err as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seedRepo: github.seedRepo,
        stop: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          await github.stop();
        },
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/test-support/fake-repo-backend.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean — this is the step that proves the boundary rule in Global Constraints actually holds for this new file.

- [ ] **Step 6: Commit**

```bash
git add client/src/test-support/fake-repo-backend.ts client/src/test-support/fake-repo-backend.test.ts
git commit -m "test: add client-side fake /api/repo backend for repo-sync integration tests"
```

---

### Task 5: `linkWorkspaceAndSync`

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `clearRepoSyncMetadata` (Task 3, `./stores/docs`), `startFakeRepoBackend`/`FakeRepoBackend` (Task 4, `./test-support/fake-repo-backend`), `pushToRepo`/`pullFromRepo`/`PullPlan` (already in this file), `repoSyncBusyLabel` (`./stores/repoSync`, already exists).
- Produces:
  ```ts
  export interface LinkAndSyncResult {
    pullPlan: PullPlan;
    applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
  }
  export async function linkWorkspaceAndSync(
    workspaceId: string,
    repoLink: { owner: string; repo: string; branch: string }
  ): Promise<LinkAndSyncResult>;
  ```

- [ ] **Step 1: Write the failing tests**

In `client/src/repo-sync.test.ts`, change the top import block from:
```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  slugifyDocName,
  dedupeRepoPath,
  rewriteImagesForPush,
  resolveImagesFromPull,
  planPull,
  planPush,
  planCreateWorkspaceFromRepo,
  type TreeEntry,
} from "./repo-sync";
import type { Doc, Workspace } from "./types";
```
to:
```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  slugifyDocName,
  dedupeRepoPath,
  rewriteImagesForPush,
  resolveImagesFromPull,
  planPull,
  planPush,
  planCreateWorkspaceFromRepo,
  linkWorkspaceAndSync,
  type TreeEntry,
} from "./repo-sync";
import { docsStore } from "./stores/docs";
import { createWorkspace } from "./stores/workspaces";
import { startFakeRepoBackend, type FakeRepoBackend } from "./test-support/fake-repo-backend";
import type { Doc, Workspace } from "./types";
```

Append at the end of the file:

```ts
describe("linkWorkspaceAndSync", () => {
  let backend: FakeRepoBackend;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    backend = await startFakeRepoBackend();
    realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const rewritten = url.startsWith("/api/repo") ? `${backend.baseUrl}${url}` : url;
      return realFetch(rewritten, init);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await backend.stop();
  });

  it("pushes local docs and pulls in the repo's pre-existing content, without touching it", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "pre-existing" }]);
    const ws = createWorkspace("Test Workspace");
    docsStore.set([{ id: "local-1", name: "Local Doc", content: "my local content", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);

    await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(2);

    const localDoc = docs.find((d) => d.id === "local-1")!;
    expect(localDoc.repoPath).toBeDefined();
    expect(localDoc.repoSha).toBeDefined();

    const pulledDoc = docs.find((d) => d.repoPath === "existing.md");
    expect(pulledDoc).toBeDefined();
    expect(pulledDoc!.content).toBe("pre-existing");
  });

  it("clears stale repo-sync metadata from a previous link so relinking to a different repo with a same-named file doesn't falsely conflict", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "notes.md", content: "fresh content from the new repo" }]);
    const ws = createWorkspace("Test Workspace 2");
    docsStore.set([
      {
        id: "stale-doc",
        name: "Notes",
        content: "old content from a different repo",
        updatedAt: 1,
        createdAt: 1,
        workspaceId: ws.id,
        repoPath: "notes.md",
        repoSha: "stale-sha-from-a-different-repo",
      },
    ]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    expect(result.pullPlan.conflicts).toEqual([]);
    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(2);

    const staleDoc = docs.find((d) => d.id === "stale-doc")!;
    expect(staleDoc.repoPath).toBe("notes-2.md"); // deduped against the repo's own notes.md
    expect(staleDoc.content).toBe("old content from a different repo");

    const pulledDoc = docs.find((d) => d.repoPath === "notes.md")!;
    expect(pulledDoc.content).toBe("fresh content from the new repo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `linkWorkspaceAndSync` isn't exported from `./repo-sync` yet.

- [ ] **Step 3: Write the implementation**

In `client/src/repo-sync.ts`, change:
```ts
import { docsInWorkspace, upsertDocFromRepo, removeDocsByRepoPaths, setDocRepoLinkById, ensureActiveDocInWorkspace } from "./stores/docs";
```
to:
```ts
import { docsInWorkspace, upsertDocFromRepo, removeDocsByRepoPaths, setDocRepoLinkById, ensureActiveDocInWorkspace, clearRepoSyncMetadata } from "./stores/docs";
```

Add a new import below the existing ones:
```ts
import { repoSyncBusyLabel } from "./stores/repoSync";
```

Append at the end of the file:

```ts
export interface LinkAndSyncResult {
  pullPlan: PullPlan;
  applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
}

// Push conflicts can never happen here: clearRepoSyncMetadata (above)
// strips every doc's repoPath first, and planPush only ever raises a
// conflict when a doc already has one — so the push step's own plan is
// safe to discard. Pull conflicts, on the other hand, are possible (the
// tree could move between the push and pull calls below) and are
// returned to the caller to route through the shared repoConflictModal,
// exactly like the manual "Pull from Repo" action already does.
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  repoSyncBusyLabel.set("Pushing…");
  await pushToRepo(workspaceId, repoLink);
  repoSyncBusyLabel.set("Pulling…");
  const { plan, applyResolved } = await pullFromRepo(workspaceId, repoLink, new Set());
  return { pullPlan: plan, applyPullResolved: applyResolved };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: add linkWorkspaceAndSync — push then pull on link"
```

---

### Task 6: Wire `RepoLinkModal.svelte`

**Files:**
- Modify: `client/src/components/RepoLinkModal.svelte`

**Interfaces:**
- Consumes: `linkWorkspaceAndSync`, `LinkAndSyncResult` (Task 5), `repoSyncBusyLabel`/`repoConflictModalOpen`/`repoConflictState` (`../stores/repoSync`, all already exist), `docsInWorkspace` (`../stores/docs`, already exists).

- [ ] **Step 1: Replace `RepoLinkModal.svelte`'s script block**

Replace the full contents of `client/src/components/RepoLinkModal.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import { repoLinkModalOpen, repoSyncBusyLabel, repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { activeWorkspaceIdStore } from "../stores/workspaces";
  import { docsInWorkspace } from "../stores/docs";
  import { linkWorkspaceAndSync } from "../repo-sync";
  import { showToast } from "../stores/toast";

  function close() {
    repoLinkModalOpen.set(false);
  }

  function docNameFor(workspaceId: string, docId: string): string {
    return docsInWorkspace(workspaceId).find((d) => d.id === docId)?.name || "Untitled";
  }

  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    try {
      const { pullPlan, applyPullResolved } = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      close();
      if (pullPlan.conflicts.length > 0 || pullPlan.deletions.length > 0) {
        repoConflictState.set({
          kind: "pull",
          conflicts: pullPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: pullPlan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(workspaceId, d.docId), repoPath: d.repoPath })),
          onResolve: applyPullResolved,
        });
        repoConflictModalOpen.set(true);
      } else {
        showToast(`Linked to ${owner}/${repo}`, "success");
      }
    } catch (err: any) {
      showToast(err.message || "Couldn't sync after linking", "error");
    } finally {
      repoSyncBusyLabel.set(null);
    }
  }

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
    <RepoPicker open={$repoLinkModalOpen} onPick={linkWorkspace} />
  </Modal>
{/if}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 3: Manual verification**

Run the dev server (`npm run dev:client`). Since this flow requires a real or faked GitHub session (`requireRepoScope()` gates entry to this modal), use the same in-browser Svelte-store bypass technique established for this feature area: open the app, then via the browser devtools console (or the Chrome MCP `javascript_tool`):
```js
const mod = await import('/src/stores/repoSync.ts');
mod.repoLinkModalOpen.set(true);
```
Then, in the resulting modal, either paste a real `owner/repo` you control that already has some `.md` content (requires being signed in with GitHub for the picker's fetch/push calls to actually succeed), or — for a purely visual check with no real GitHub session — confirm the modal renders identically to before (owner/repo field, create section, Your Repos list) and that submitting shows the "Sign in required" scope-gate prompt, matching every other repo-sync entry point's gated behavior. Full behavioral verification (a real push+pull actually happening) is covered by the manual E2E step in Task 7, against a real repo.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/RepoLinkModal.svelte
git commit -m "feat: linking a workspace now pushes and pulls automatically"
```

---

### Task 7: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including every test added in Tasks 1–6.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated to this work).

- [ ] **Step 4: Manual E2E against a real repo**

Per this codebase's existing practice for repo-sync features (see `scripts/manual-testing/repo-sync-e2e.mjs` for the pattern — sign in with a real GitHub OAuth session, since `requireRepoScope()` rejects the dev-login fake session): link a workspace that has at least one local document to a real repo that itself already has `.md` content. Confirm:
- The workspace's local doc(s) appear as new files in the repo (check the repo's commit history on github.com).
- The repo's pre-existing `.md` file(s) now appear as new local docs in the workspace.
- Nothing already in the repo was modified or deleted by this operation.

This isn't a substitute for Task 5's integration test — it's the final "does this also work against real GitHub" check this codebase's manual-testing scripts already exist for.
