# Version History Repo Commits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Version History becomes the single place to see, diff, and restore a document's history — local snapshots and (for a repo-linked document) the repo commits that touched its file, merged into one chronological list, each diffable against current content and restorable.

**Architecture:** `handleRepoCommits` gains an optional `path` filter; a new `workspace-room.ts` endpoint lets a shared document's content be replaced by arbitrary text (not just a pre-existing snapshot id); `VersionHistory.svelte` merges local snapshots and path-filtered commits into one list with a Preview/Diff toggle reusing Phase 1's `DiffView.svelte`; the standalone Repo Info panel and all its wiring are deleted.

**Tech Stack:** TypeScript, Svelte 5, Cloudflare Workers (Durable Objects), Vitest.

## Global Constraints

- Every diff in this feature compares the selected entry against the document's *current live* content (`activeDocContent` store) — never entry-vs-entry.
- No "Load more" pagination for the commit portion of the merged list — first page (30) only.
- No filter toggle between local/commit entries — one merged, chronologically-sorted list.
- The standalone Repo Info panel (`RepoInfoPanel.svelte` and everything wiring it up) is deleted entirely once this ships.
- No new Svelte component tests — matches this codebase's established precedent.

---

### Task 1: Server — `path`-filtered commit history

**Files:**
- Modify: `src/github-repo.ts`
- Modify: `src/worker.ts`
- Test: `src/github-repo.test.ts`

**Interfaces:**
- Produces: `handleRepoCommits(request, env, owner, repo, branch, page, path?: string): Promise<Response>` — `path` is a new optional 6th parameter; every existing call site (Phase 1's) continues to work unchanged since it's optional.

- [ ] **Step 1: Write the failing test**

In `src/github-repo.test.ts`, find:

```ts
  it("proxies a non-200 upstream response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=missing-branch", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "missing-branch", 1);
    expect(res.status).toBe(404);
  });
});

describe("handleRepoFileAtRef", () => {
```

Change to:

```ts
  it("proxies a non-200 upstream response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=missing-branch", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "missing-branch", 1);
    expect(res.status).toBe(404);
  });

  it("includes a path filter in the upstream URL when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/commits?sha=main&page=1&per_page=30&path=Notes.md");
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main&path=Notes.md", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1, "Notes.md");
    expect(res.status).toBe(200);
  });

  it("omits the path filter when not provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/commits?sha=main&page=1&per_page=30");
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1);
    expect(res.status).toBe(200);
  });
});

describe("handleRepoFileAtRef", () => {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/github-repo.test.ts`
Expected: FAIL — the path-filter test expects a URL with `&path=Notes.md` that the current implementation never adds.

- [ ] **Step 3: Implement the `path` parameter**

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
export async function handleRepoCommits(request: Request, env: Env, owner: string, repo: string, branch: string, page: number, path?: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const pathParam = path ? `&path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&page=${page}&per_page=30${pathParam}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Wire the `path` query param through the route**

In `src/worker.ts`, find:

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
      const path = url.searchParams.get("path") || undefined;
      return handleRepoCommits(request, env, repoCommitsMatch[1]!, repoCommitsMatch[2]!, branch, page, path);
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
git commit -m "feat: filter repo commit history by file path"
```

---

### Task 2: Server + client — restore-from-arbitrary-content for shared docs

**Files:**
- Modify: `src/workspace-room.ts`
- Modify: `client/src/history.ts`
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Produces: `WorkspaceRoom.handleVersionRestoreContentRequest(request: Request, docId: string): Promise<Response>` (server); `restoreSharedVersionContent(workspaceId: string, docId: string, content: string): Promise<boolean>` and `restoreLocalVersionContent(docId: string, content: string, now?: number): Promise<void>` (client, both exported from `client/src/history.ts`). Task 3 consumes both client functions.

- [ ] **Step 1: Write the failing tests**

In `src/workspace-room.test.ts`, find:

```ts
  it("keeps docA's and docB's snapshots independent", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docA = await room.loadDocRoom("docA");
    const docB = await room.loadDocRoom("docB");
    docA.doc.transact(() => docA.doc.getText("content").insert(0, "A"), "storage");
    docB.doc.transact(() => docB.doc.getText("content").insert(0, "B"), "storage");
    await room.maybeSnapshot("docA", docA, 1000);
    await room.maybeSnapshot("docB", docB, 1000);
    expect((await room.getSnapshots("docA"))[0]!.content).toBe("A");
    expect((await room.getSnapshots("docB"))[0]!.content).toBe("B");
  });
});

describe("WorkspaceRoom comment threads", () => {
```

Change to:

```ts
  it("keeps docA's and docB's snapshots independent", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docA = await room.loadDocRoom("docA");
    const docB = await room.loadDocRoom("docB");
    docA.doc.transact(() => docA.doc.getText("content").insert(0, "A"), "storage");
    docB.doc.transact(() => docB.doc.getText("content").insert(0, "B"), "storage");
    await room.maybeSnapshot("docA", docA, 1000);
    await room.maybeSnapshot("docB", docB, 1000);
    expect((await room.getSnapshots("docA"))[0]!.content).toBe("A");
    expect((await room.getSnapshots("docB"))[0]!.content).toBe("B");
  });
});

describe("WorkspaceRoom.handleVersionRestoreContentRequest", () => {
  it("replaces the doc's content and records a new snapshot", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "old content"), "storage");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/versions/restore-content", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "restored content" }),
    });
    const res = await room.handleVersionRestoreContentRequest(request, "docA");
    expect(res.status).toBe(200);
    expect(docRoom.doc.getText("content").toString()).toBe("restored content");
    const snapshots = await room.getSnapshots("docA");
    expect(snapshots[snapshots.length - 1]!.content).toBe("restored content");
  });

  it("rejects a non-editor", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "reviewer" }],
    });
    await room.loadDocRoom("docA");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "bob" });
    const request = new Request("https://example.com/w/ws1/docs/docA/versions/restore-content", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "restored content" }),
    });
    const res = await room.handleVersionRestoreContentRequest(request, "docA");
    expect(res.status).toBe(403);
  });

  it("rejects a request with no content", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.loadDocRoom("docA");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/versions/restore-content", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await room.handleVersionRestoreContentRequest(request, "docA");
    expect(res.status).toBe(400);
  });
});

describe("WorkspaceRoom comment threads", () => {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/workspace-room.test.ts`
Expected: FAIL — `handleVersionRestoreContentRequest` doesn't exist yet.

- [ ] **Step 3: Implement the server handler and route**

In `src/workspace-room.ts`, find:

```ts
  async handleVersionRestoreRequest(request: Request, docId: string, versionId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can restore a version.", { status: 403 });
    const snapshots = await this.getSnapshots(docId);
    const snap = snapshots.find((s) => s.id === versionId);
    if (!snap) return new Response("Version not found.", { status: 404 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, snap.content);
    }, "restore");
    const created = await this.forceSnapshot(docId, docRoom, snap.content);
    return Response.json(created);
  }
```

Change to:

```ts
  async handleVersionRestoreRequest(request: Request, docId: string, versionId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can restore a version.", { status: 403 });
    const snapshots = await this.getSnapshots(docId);
    const snap = snapshots.find((s) => s.id === versionId);
    if (!snap) return new Response("Version not found.", { status: 404 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, snap.content);
    }, "restore");
    const created = await this.forceSnapshot(docId, docRoom, snap.content);
    return Response.json(created);
  }

  // Same as handleVersionRestoreRequest above, but for content that
  // didn't come from an existing tracked snapshot (e.g. fetched fresh
  // from a repo commit) — takes the content directly instead of
  // looking it up by versionId.
  async handleVersionRestoreContentRequest(request: Request, docId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can restore a version.", { status: 403 });
    let body: { content?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const content = typeof body.content === "string" ? body.content : undefined;
    if (content === undefined) return new Response("content is required.", { status: 400 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, content);
    }, "restore");
    const created = await this.forceSnapshot(docId, docRoom, content);
    return Response.json(created);
  }
```

Find:

```ts
    const restoreMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (restoreMatch) return this.handleVersionRestoreRequest(request, restoreMatch[1]!, restoreMatch[2]!);
    const versionMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)$/);
    if (versionMatch) return this.handleVersionContentRequest(request, versionMatch[1]!, versionMatch[2]!);
```

Change to:

```ts
    const restoreMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (restoreMatch) return this.handleVersionRestoreRequest(request, restoreMatch[1]!, restoreMatch[2]!);
    const restoreContentMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/restore-content$/);
    if (restoreContentMatch) return this.handleVersionRestoreContentRequest(request, restoreContentMatch[1]!);
    const versionMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)$/);
    if (versionMatch) return this.handleVersionContentRequest(request, versionMatch[1]!, versionMatch[2]!);
```

(`restoreContentMatch` must be checked before `versionMatch` — otherwise `versionMatch`'s generic `/versions/([^/]+)$/` pattern would capture "restore-content" as if it were a version id.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workspace-room.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Add the client-side functions**

In `client/src/history.ts`, find:

```ts
export async function restoreLocalVersion(docId: string, versionId: string, now: number = Date.now()): Promise<string | undefined> {
  const content = await getVersionContent(docId, versionId);
  if (content === undefined) return undefined;
  await appendSnapshot(docId, content, now);
  return content;
}
```

Change to:

```ts
export async function restoreLocalVersion(docId: string, versionId: string, now: number = Date.now()): Promise<string | undefined> {
  const content = await getVersionContent(docId, versionId);
  if (content === undefined) return undefined;
  await appendSnapshot(docId, content, now);
  return content;
}

// For restoring content that didn't come from an existing local
// snapshot (e.g. fetched fresh from a repo commit) — same
// force-append-for-undo-safety guarantee as restoreLocalVersion above,
// just skipping the snapshot lookup since the caller already has the
// content in hand.
export async function restoreLocalVersionContent(docId: string, content: string, now: number = Date.now()): Promise<void> {
  await appendSnapshot(docId, content, now);
}
```

Find:

```ts
export async function restoreSharedVersion(workspaceId: string, docId: string, versionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
    return res.ok;
  } catch (err) {
    return false;
  }
}
```

Change to:

```ts
export async function restoreSharedVersion(workspaceId: string, docId: string, versionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
    return res.ok;
  } catch (err) {
    return false;
  }
}

export async function restoreSharedVersionContent(workspaceId: string, docId: string, content: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions/restore-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}
```

- [ ] **Step 6: Typecheck both**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/workspace-room.ts src/workspace-room.test.ts client/src/history.ts
git commit -m "feat: allow restoring a shared document to arbitrary content, not just an existing snapshot"
```

---

### Task 3: `VersionHistory.svelte` — merged list, diff, and commit restore

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `DiffView.svelte` (Phase 1, `./DiffView.svelte`), `activeDocContent` store (`../stores/docs`), `restoreLocalVersionContent`/`restoreSharedVersionContent` from Task 2 (`../history`), `handleRepoFileAtRef`'s route from Phase 1 (`GET /api/repo/:owner/:repo/contents/:path?ref=X`), `handleRepoCommits`'s new `path` param from Task 1 (`GET /api/repo/:owner/:repo/commits?branch=X&page=1&path=Y`).
- Produces: nothing new consumed by later tasks — this is the last feature task before removal and final verification.

- [ ] **Step 1: Replace the script block**

In `client/src/components/VersionHistory.svelte`, find:

```svelte
<script lang="ts">
  import { get } from "svelte/store";
  import { onMount } from "svelte";
  import { versionHistoryOpen } from "../stores/versionHistory";
  import { getActiveDoc } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
  import {
    listVersions,
    getVersionContent,
    restoreLocalVersion,
    listSharedVersions,
    getSharedVersionContent,
    restoreSharedVersion,
    type VersionSummary,
  } from "../history";
  import { renderVersionPreview } from "../version-preview";
  import { showToast } from "../stores/toast";

  function isDocShared(doc: ReturnType<typeof getActiveDoc>): boolean {
    return !!(doc && get(workspacesStore).find((w) => w.id === doc.workspaceId)?.shared);
  }

  let versions = $state<VersionSummary[]>([]);
  let selectedId = $state<string | null>(null);
  let previewEl: HTMLDivElement | undefined = $state();
  let loading = $state(false);
  let restoring = $state(false);
  // Re-checked each time the overlay opens (see loadVersions) — a local
  // document is always restorable; a shared one only if this client
  // currently has editor access, mirroring the server's own 403 gate so
  // the button isn't shown as available when it would just fail.
  let restoreAllowed = $state(true);

  function close() {
    versionHistoryOpen.set(false);
  }

  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, id: string) {
    selectedId = id;
    if (!doc || !previewEl) return;
    const content = isShared ? await getSharedVersionContent(doc.workspaceId, doc.id, id) : await getVersionContent(doc.id, id);
    if (content !== undefined && previewEl) await renderVersionPreview(content, doc, previewEl);
  }

  async function loadVersions() {
    const doc = getActiveDoc();
    if (!doc) {
      versions = [];
      return;
    }
    const isShared = isDocShared(doc);
    restoreAllowed = !isShared || !window.MDE.getEditor().state.readOnly;
    loading = true;
    versions = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
    loading = false;
    if (versions.length > 0) await selectVersion(doc, isShared, versions[0]!.id);
    else selectedId = null;
  }

  async function restore() {
    const doc = getActiveDoc();
    if (!doc || !selectedId || restoring) return;
    restoring = true;
    const isShared = isDocShared(doc);
    if (isShared) {
      const ok = await restoreSharedVersion(doc.workspaceId, doc.id, selectedId);
      if (ok) {
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    } else {
      const content = await restoreLocalVersion(doc.id, selectedId);
      if (content !== undefined) {
        const cm = window.MDE.getEditor();
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: content } });
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    }
    restoring = false;
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  $effect(() => {
    if ($versionHistoryOpen) void loadVersions();
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $versionHistoryOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    // Topbar icon button, next to Share — same open() this component's own
    // File-menu entry (MenuBar.svelte) triggers, matching Settings.svelte's
    // own #settingsBtn wiring pattern for a header-icon-triggered overlay.
    const open = () => versionHistoryOpen.set(true);
    document.getElementById("versionHistoryBtn")?.addEventListener("click", open);
    return () => {
      document.removeEventListener("keydown", onKeydown);
      document.getElementById("versionHistoryBtn")?.removeEventListener("click", open);
    };
  });
</script>
```

Change to:

```svelte
<script lang="ts">
  import { get } from "svelte/store";
  import { onMount } from "svelte";
  import { versionHistoryOpen } from "../stores/versionHistory";
  import { getActiveDoc, activeDocContent } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
  import {
    listVersions,
    getVersionContent,
    restoreLocalVersion,
    restoreLocalVersionContent,
    listSharedVersions,
    getSharedVersionContent,
    restoreSharedVersion,
    restoreSharedVersionContent,
    type VersionSummary,
  } from "../history";
  import { renderVersionPreview } from "../version-preview";
  import { showToast } from "../stores/toast";
  import DiffView from "./DiffView.svelte";

  interface LocalEntry {
    kind: "local";
    id: string;
    timestamp: number;
  }
  interface CommitEntry {
    kind: "commit";
    id: string;
    timestamp: number;
    message: string;
    author: string;
    html_url: string;
  }
  type HistoryEntry = LocalEntry | CommitEntry;

  function isDocShared(doc: ReturnType<typeof getActiveDoc>): boolean {
    return !!(doc && get(workspacesStore).find((w) => w.id === doc.workspaceId)?.shared);
  }

  let versions = $state<HistoryEntry[]>([]);
  let selectedId = $state<string | null>(null);
  let selectedEntry = $state<HistoryEntry | null>(null);
  let selectedContent = $state<string | undefined>(undefined);
  let viewMode = $state<"preview" | "diff">("preview");
  let previewEl: HTMLDivElement | undefined = $state();
  let loading = $state(false);
  let restoring = $state(false);
  // Re-checked each time the overlay opens (see loadVersions) — a local
  // document is always restorable; a shared one only if this client
  // currently has editor access, mirroring the server's own 403 gate so
  // the button isn't shown as available when it would just fail.
  let restoreAllowed = $state(true);

  function close() {
    versionHistoryOpen.set(false);
  }

  function firstLine(message: string): string {
    return message.split("\n")[0] || message;
  }

  async function fetchCommitContent(doc: ReturnType<typeof getActiveDoc>, sha: string): Promise<string | undefined> {
    if (!doc?.repoPath) return undefined;
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    const repoLink = ws?.repoLink;
    if (!repoLink) return undefined;
    const encodedPath = doc.repoPath.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { content: string; encoding: string };
    if (data.encoding !== "base64") return data.content;
    return atob(data.content.replace(/\n/g, ""));
  }

  async function loadCommitEntries(doc: ReturnType<typeof getActiveDoc>): Promise<CommitEntry[]> {
    if (!doc?.repoPath) return [];
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    const repoLink = ws?.repoLink;
    if (!repoLink) return [];
    try {
      const encodedPath = doc.repoPath.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(
        `/api/repo/${repoLink.owner}/${repoLink.repo}/commits?branch=${encodeURIComponent(repoLink.branch)}&page=1&path=${encodedPath}`
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { sha: string; commit: { message: string; author: { name: string; date: string } }; html_url: string }[];
      return data.map((c) => ({
        kind: "commit" as const,
        id: c.sha,
        timestamp: new Date(c.commit.author.date).getTime(),
        message: firstLine(c.commit.message),
        author: c.commit.author.name,
        html_url: c.html_url,
      }));
    } catch (err) {
      return [];
    }
  }

  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, entry: HistoryEntry) {
    selectedId = entry.id;
    selectedEntry = entry;
    selectedContent = undefined;
    if (!doc) return;
    const content =
      entry.kind === "local"
        ? isShared
          ? await getSharedVersionContent(doc.workspaceId, doc.id, entry.id)
          : await getVersionContent(doc.id, entry.id)
        : await fetchCommitContent(doc, entry.id);
    if (content === undefined) {
      showToast("Couldn't load this version's content", "error");
      return;
    }
    selectedContent = content;
  }

  async function loadVersions() {
    const doc = getActiveDoc();
    if (!doc) {
      versions = [];
      return;
    }
    const isShared = isDocShared(doc);
    restoreAllowed = !isShared || !window.MDE.getEditor().state.readOnly;
    loading = true;
    const localList = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
    const localEntries: HistoryEntry[] = localList.map((v) => ({ kind: "local" as const, id: v.id, timestamp: v.timestamp }));
    const commitEntries: HistoryEntry[] = await loadCommitEntries(doc);
    versions = [...localEntries, ...commitEntries].sort((a, b) => b.timestamp - a.timestamp);
    loading = false;
    if (versions.length > 0) await selectVersion(doc, isShared, versions[0]!);
    else {
      selectedId = null;
      selectedEntry = null;
    }
  }

  async function restore() {
    const doc = getActiveDoc();
    if (!doc || !selectedEntry || restoring || selectedContent === undefined) return;
    restoring = true;
    const isShared = isDocShared(doc);
    const entry = selectedEntry;
    const content = selectedContent;
    if (isShared) {
      const ok =
        entry.kind === "local"
          ? await restoreSharedVersion(doc.workspaceId, doc.id, entry.id)
          : await restoreSharedVersionContent(doc.workspaceId, doc.id, content);
      if (ok) {
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    } else if (entry.kind === "local") {
      const restoredContent = await restoreLocalVersion(doc.id, entry.id);
      if (restoredContent !== undefined) {
        const cm = window.MDE.getEditor();
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: restoredContent } });
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    } else {
      await restoreLocalVersionContent(doc.id, content);
      const cm = window.MDE.getEditor();
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: content } });
      showToast("Version restored", "success");
      close();
    }
    restoring = false;
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  $effect(() => {
    if ($versionHistoryOpen) void loadVersions();
  });

  // Re-renders the plain preview whenever the selected content changes
  // or the toggle switches back to "preview" — separate from
  // selectVersion() so switching modes on an already-selected entry
  // doesn't need to re-fetch anything.
  $effect(() => {
    if (viewMode === "preview" && selectedContent !== undefined && previewEl) {
      const doc = getActiveDoc();
      if (doc) void renderVersionPreview(selectedContent, doc, previewEl);
    }
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $versionHistoryOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    // Topbar icon button, next to Share — same open() this component's own
    // File-menu entry (MenuBar.svelte) triggers, matching Settings.svelte's
    // own #settingsBtn wiring pattern for a header-icon-triggered overlay.
    const open = () => versionHistoryOpen.set(true);
    document.getElementById("versionHistoryBtn")?.addEventListener("click", open);
    return () => {
      document.removeEventListener("keydown", onKeydown);
      document.getElementById("versionHistoryBtn")?.removeEventListener("click", open);
    };
  });
</script>
```

- [ ] **Step 2: Replace the template**

Find:

```svelte
{#if $versionHistoryOpen}
  <div class="version-history-overlay" role="dialog" aria-modal="true" aria-labelledby="versionHistoryTitle">
    <div class="version-history-header">
      <h2 id="versionHistoryTitle">Version history</h2>
      <button type="button" class="secondary-btn" onclick={close}>Close</button>
    </div>
    <div class="version-history-body">
      <div class="version-history-list">
        {#if loading}
          <div class="empty-state">
            <svg class="empty-state-icon"><use href="#icon-clock"></use></svg>
            <div class="empty-state-title">Loading…</div>
          </div>
        {:else if versions.length === 0}
          <div class="empty-state">
            <svg class="empty-state-icon"><use href="#icon-clock"></use></svg>
            <div class="empty-state-title">No versions yet</div>
            <div class="empty-state-desc">History builds up automatically as you edit.</div>
          </div>
        {:else}
          {#each versions as v, i (v.id)}
            <button
              type="button"
              class="version-history-row"
              class:active={v.id === selectedId}
              onclick={() => selectVersion(getActiveDoc(), isDocShared(getActiveDoc()), v.id)}
            >
              <span>{formatTimestamp(v.timestamp)}</span>
              {#if i === 0}<span class="version-history-current">(current)</span>{/if}
            </button>
          {/each}
        {/if}
      </div>
      <div class="version-history-preview-wrap">
        <div class="version-history-preview" bind:this={previewEl}></div>
        <div class="version-history-actions">
          <button type="button" class="primary-btn" disabled={!selectedId || restoring || !restoreAllowed || selectedId === versions[0]?.id} onclick={restore}>
            Restore this version
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
```

Change to:

```svelte
{#if $versionHistoryOpen}
  <div class="version-history-overlay" role="dialog" aria-modal="true" aria-labelledby="versionHistoryTitle">
    <div class="version-history-header">
      <h2 id="versionHistoryTitle">Version history</h2>
      <button type="button" class="secondary-btn" onclick={close}>Close</button>
    </div>
    <div class="version-history-body">
      <div class="version-history-list">
        {#if loading}
          <div class="empty-state">
            <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
            <div class="empty-state-title">Loading…</div>
          </div>
        {:else if versions.length === 0}
          <div class="empty-state">
            <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
            <div class="empty-state-title">No versions yet</div>
            <div class="empty-state-desc">History builds up automatically as you edit.</div>
          </div>
        {:else}
          {#each versions as v, i (v.id)}
            <button
              type="button"
              class="version-history-row"
              class:active={v.id === selectedId}
              onclick={() => selectVersion(getActiveDoc(), isDocShared(getActiveDoc()), v)}
            >
              <span class="version-history-row-label">
                {#if v.kind === "commit"}
                  <svg class="icon"><use href="#icon-github"></use></svg>
                  {v.message}
                {:else}
                  {formatTimestamp(v.timestamp)}
                {/if}
              </span>
              {#if i === 0}<span class="version-history-current">(current)</span>{/if}
            </button>
          {/each}
        {/if}
      </div>
      <div class="version-history-preview-wrap">
        <div class="version-history-view-toggle">
          <button type="button" class:active={viewMode === "preview"} onclick={() => (viewMode = "preview")}>Preview</button>
          <button type="button" class:active={viewMode === "diff"} onclick={() => (viewMode = "diff")}>Diff</button>
        </div>
        {#if viewMode === "diff"}
          <div class="version-history-preview">
            <DiffView before={selectedContent ?? ""} after={$activeDocContent} />
          </div>
        {:else}
          <div class="version-history-preview" bind:this={previewEl}></div>
        {/if}
        <div class="version-history-actions">
          <button type="button" class="primary-btn" disabled={!selectedId || restoring || !restoreAllowed || selectedId === versions[0]?.id} onclick={restore}>
            Restore this version
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
```

- [ ] **Step 3: Add CSS**

In `client/src/style.css`, find:

```css
.version-history-row.active { background: var(--accent-dim); color: var(--accent); }
.version-history-current { font-size: 11px; color: var(--text-dim); }
.version-history-preview-wrap {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.version-history-preview {
  flex: 1;
  overflow: auto;
  padding: 20px;
}
```

Change to:

```css
.version-history-row.active { background: var(--accent-dim); color: var(--accent); }
.version-history-row-label { display: flex; align-items: center; gap: 6px; }
.version-history-current { font-size: 11px; color: var(--text-dim); }
.version-history-preview-wrap {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.version-history-view-toggle { display: flex; gap: 4px; padding: 12px 20px 0; flex-shrink: 0; }
.version-history-view-toggle button {
  border: none;
  background: var(--bg-alt);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--text-dim);
  font-family: inherit;
}
.version-history-view-toggle button.active { background: var(--accent-dim); color: var(--accent); }
.version-history-preview {
  flex: 1;
  overflow: auto;
  padding: 20px;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/VersionHistory.svelte client/src/style.css
git commit -m "feat: merge repo commits into Version History with diff and restore"
```

---

### Task 4: Remove the standalone Repo Info panel

**Files:**
- Delete: `client/src/components/RepoInfoPanel.svelte`
- Delete: `client/src/stores/repoInfoPanel.ts`
- Modify: `client/src/repo-sync-ui.ts`
- Modify: `client/src/types.ts`
- Modify: `client/src/components/MenuBar.svelte`
- Modify: `client/index.html`
- Modify: `client/src/main.ts`
- Modify: `client/src/style.css`

**Interfaces:**
- None — pure removal, nothing here is consumed by any later task.

- [ ] **Step 1: Delete the component and its store**

```bash
rm client/src/components/RepoInfoPanel.svelte client/src/stores/repoInfoPanel.ts
```

- [ ] **Step 2: Remove the bridge function**

In `client/src/repo-sync-ui.ts`, find:

```ts
import { repoLinkModalOpen, openRepoModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
import { repoInfoPanelOpen } from "./stores/repoInfoPanel";
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast, showToast } from "./stores/toast";
```

Change to:

```ts
import { repoLinkModalOpen, openRepoModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast, showToast } from "./stores/toast";
```

Find:

```ts
window.MDE.openRepoModal = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    openRepoModalOpen.set(true);
  })();
};

window.MDE.openRepoInfoPanel = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    repoInfoPanelOpen.set(true);
  })();
};

window.MDE.unlinkRepo = () => {
```

Change to:

```ts
window.MDE.openRepoModal = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    openRepoModalOpen.set(true);
  })();
};

window.MDE.unlinkRepo = () => {
```

- [ ] **Step 3: Remove the type declaration**

In `client/src/types.ts`, find:

```ts
  openRepoLinkModal?(): void;
  openRepoModal?(): void;
  openRepoInfoPanel?(): void;
  pushToRepoAction?(): void;
```

Change to:

```ts
  openRepoLinkModal?(): void;
  openRepoModal?(): void;
  pushToRepoAction?(): void;
```

- [ ] **Step 4: Remove the menu entry**

In `client/src/components/MenuBar.svelte`, find:

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

Change to:

```svelte
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pushToRepoAction?.())}>
              <svg class="icon"><use href="#icon-upload"></use></svg> {$repoSyncBusyLabel === "Pushing…" ? "Pushing…" : "Push to Repo"}
            </button>
            <button type="button" onclick={() => act(() => window.MDE.unlinkRepo?.())}>
              <svg class="icon"><use href="#icon-x"></use></svg> Unlink Repo
            </button>
```

- [ ] **Step 5: Remove the mount point**

In `client/index.html`, find:

```html
<!-- Repo Info panel — Svelte component, mounted in main.ts; see
     client/src/components/RepoInfoPanel.svelte -->
<div id="repo-info-panel-mount"></div>
```

Delete this block entirely (including the blank line directly above it, so exactly one blank line remains between the preceding block and whatever follows).

In `client/src/main.ts`, find:

```ts
import DocInfoPanel from "./components/DocInfoPanel.svelte";
import RepoInfoPanel from "./components/RepoInfoPanel.svelte";
import ConfirmDialog from "./components/ConfirmDialog.svelte";
```

Change to:

```ts
import DocInfoPanel from "./components/DocInfoPanel.svelte";
import ConfirmDialog from "./components/ConfirmDialog.svelte";
```

Find:

```ts
mount(DocInfoPanel, { target: document.getElementById("doc-info-panel-mount")! });
mount(RepoInfoPanel, { target: document.getElementById("repo-info-panel-mount")! });
mount(ConfirmDialog, { target: document.getElementById("confirm-dialog-mount")! });
```

Change to:

```ts
mount(DocInfoPanel, { target: document.getElementById("doc-info-panel-mount")! });
mount(ConfirmDialog, { target: document.getElementById("confirm-dialog-mount")! });
```

- [ ] **Step 6: Remove the now-unused CSS**

In `client/src/style.css`, find:

```css
.repo-commit-row { display: flex; align-items: center; gap: 10px; background: var(--bg-alt); border-radius: 6px; padding: 6px 10px; }
.repo-commit-row input[type="checkbox"] { flex-shrink: 0; cursor: pointer; }
.repo-commit-link { flex: 1; min-width: 0; display: flex; flex-direction: column; text-decoration: none; font-size: 13px; color: inherit; }
.repo-commit-link:hover { text-decoration: underline; }
.repo-commit-compare-bar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.repo-commit-compare-bar .secondary-btn { width: auto; margin-bottom: 0; }
```

Delete this block entirely.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 9: Manual verification**

With the `npm run dev` full stack (Worker + GitHub OAuth) and a document synced to a real repo with commit history:

- Open File > Version history — confirm the list shows both local snapshots and commits touching this document's file, correctly interleaved by time, commits showing a GitHub icon and their first commit-message line, local entries showing their timestamp.
- Select a commit entry, click "Diff" — confirm it renders correctly against current content; click "Preview" — confirm it renders the commit's content as markdown.
- On a local-only (non-shared) document, restore from a commit entry — confirm the editor updates and a new local snapshot appears in the list afterward.
- On a shared/collaborative document (two connected clients), restore from a commit entry from one client — confirm the second client's content updates too.
- Confirm `File > GitHub Repo` no longer has a "Repo info" entry, and confirm nothing else broke in that submenu (Pull/Push/Unlink still present and working).

- [ ] **Step 10: Commit**

```bash
git add client/src/components/RepoInfoPanel.svelte client/src/stores/repoInfoPanel.ts client/src/repo-sync-ui.ts client/src/types.ts client/src/components/MenuBar.svelte client/index.html client/src/main.ts client/src/style.css
git commit -m "refactor: remove the standalone repo info panel, superseded by Version History"
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

Covered by Task 4's Step 9 — this needs the full `npm run dev` stack with real GitHub OAuth, a repo-linked document with commit history, and (for the shared-restore check) two connected clients on a shared workspace. If you can't run the full authenticated/collaborative stack, flag this to the user rather than attempting it blind, same as the manual-verification notes on prior plans this session.
