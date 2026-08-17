# Repo-Sync Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linking a workspace to a repo — re-linking to the same repo after unlinking, or linking to a different existing repo with same-named files — never silently creates duplicate files, and creating a brand-new repo never leaves an unwanted placeholder commit before the real content lands.

**Architecture:** `planPush` gains a "match the target repo's existing tree by name before treating a doc as brand-new" step, backed by a small workspace-identity marker file (`.mde/workspace.json`) written on every push and read before the next one — its presence/absence decides whether a name-matched-but-differing doc pushes directly or raises a conflict through the existing conflict-resolution UI. Separately, the server-side push/create endpoints gain a code path for a repo's genuine first-ever commit, removing the need for GitHub's `auto_init`.

**Tech Stack:** TypeScript, Svelte 5, Cloudflare Workers, Vitest.

## Global Constraints

- `checkWorkspaceMarker`/`markerMatchesWorkspace` fail closed: any error reading, fetching, or parsing the marker returns `false` ("not proven safe"), never `true`.
- Identical pushable content always quietly re-associates regardless of the marker (`sameWorkspace` is irrelevant to that branch) — only a genuine content difference is gated on the marker.
- A second local doc that slugifies to an already-tree-matched path falls through to the existing `dedupeRepoPath` mechanism — this change never affects genuine collisions between two of the user's own documents.
- No automatic pull is chained after resolving a push conflict during link — the user re-triggers "Pull from Repo" separately if needed (see spec's Non-goals).
- The marker is not retroactively backfilled onto already-linked, already-synced repos — it's written going forward, on the next successful push (see spec's Non-goals).

---

### Task 1: Workspace marker + `planPush` adoption logic + `pushToRepo` wiring

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Produces: `WORKSPACE_MARKER_PATH` (string constant), `WorkspaceMarker` (interface `{ workspaceId: string; name: string }`), `markerMatchesWorkspace(markerContent: string | null, workspaceId: string): boolean`, `planPush(docs: Doc[], mdEntries: TreeEntry[], sameWorkspace: boolean): Promise<PushPlan>` (signature change — new required third parameter), `checkWorkspaceMarker(repoLink: { owner: string; repo: string; branch: string }, entries: TreeEntry[], workspaceId: string): Promise<boolean>` (module-private).
- Consumes: existing `dedupeRepoPath`, `slugifyDocName`, `rewriteImagesForPush`, `slugFromRepoPath`, `gitBlobSha`, `toBase64`, `dataUrlToBase64`, `workspacesStore`, `get` (svelte/store) — all already present in this file.

- [ ] **Step 1: Write the failing marker tests**

In `client/src/repo-sync.test.ts`, add a new `describe` block right after the existing `describe("dedupeRepoPath", ...)` block (before `describe("rewriteImagesForPush", ...)`):

```ts
describe("markerMatchesWorkspace", () => {
  it("returns true when the marker's workspaceId matches", () => {
    expect(markerMatchesWorkspace(JSON.stringify({ workspaceId: "w1", name: "Notes" }), "w1")).toBe(true);
  });

  it("returns false for a marker naming a different workspace", () => {
    expect(markerMatchesWorkspace(JSON.stringify({ workspaceId: "w2", name: "Other" }), "w1")).toBe(false);
  });

  it("returns false for malformed JSON", () => {
    expect(markerMatchesWorkspace("not json", "w1")).toBe(false);
  });

  it("returns false for null content", () => {
    expect(markerMatchesWorkspace(null, "w1")).toBe(false);
  });
});
```

Add `markerMatchesWorkspace` to the existing import list at the top of the file:

```ts
import {
  slugifyDocName,
  dedupeRepoPath,
  rewriteImagesForPush,
  resolveImagesFromPull,
  planPull,
  planPush,
  planCreateWorkspaceFromRepo,
  linkWorkspaceAndSync,
  markerMatchesWorkspace,
  type TreeEntry,
} from "./repo-sync";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `markerMatchesWorkspace` is not exported yet.

- [ ] **Step 3: Add the marker helpers**

In `client/src/repo-sync.ts`, find:

```ts
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
```

Change to:

```ts
export const WORKSPACE_MARKER_PATH = ".mde/workspace.json";

export interface WorkspaceMarker {
  workspaceId: string;
  name: string;
}

// True only when the marker's content genuinely identifies THIS
// workspace — a missing file, unparseable content, or a marker naming
// some other workspace are all treated the same (not proven safe) by
// the caller.
export function markerMatchesWorkspace(markerContent: string | null, workspaceId: string): boolean {
  if (!markerContent) return false;
  try {
    const parsed = JSON.parse(markerContent) as Partial<WorkspaceMarker>;
    return parsed.workspaceId === workspaceId;
  } catch (e) {
    return false;
  }
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
```

- [ ] **Step 4: Run marker tests to verify they pass**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: the 4 new `markerMatchesWorkspace` tests PASS. The rest of the file still passes too (no other code changed yet).

- [ ] **Step 5: Write the failing `planPush` tests**

`planPush`'s existing test suite needs both rewrites (two tests assert the old dedupe-into-duplicate behavior as correct) and additions. In `client/src/repo-sync.test.ts`, find the entire `describe("planPush", ...)` block:

```ts
describe("planPush", () => {
  it("assigns a new repoPath to a doc that has never synced", async () => {
    const docs = [fakeDoc({ id: "d1", name: "My Notes", repoPath: undefined })];
    const plan = await planPush(docs, []);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("my-notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("dedupes a new repoPath against the current tree", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries);
    expect(plan.changes[0]!.repoPath).toBe("notes-2.md");
  });

  it("skips a doc whose pushable content hashes to the tree's current blob sha", async () => {
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", content: "" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    const plan = await planPush(docs, entries);
    expect(plan.changes).toEqual([]);
  });

  it("pushes a doc whose content differs from the tree's current blob sha, even if repoSha still matches", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "changed locally" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries);
    expect(plan.changes).toHaveLength(1);
  });

  it("queues a conflict when the tree's sha differs from the doc's last-known repoSha", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const plan = await planPush(docs, entries);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "a.md", remoteSha: "s2" }]);
  });

  it("pushes a doc whose repoPath is not in the tree at all yet (first push after linking)", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "hi" })];
    const plan = await planPush(docs, []);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("a.md");
  });

  it("uses the final (deduped) repoPath's own stem as the images-folder slug, not doc.name's slug", async () => {
    // Regression coverage for a slug-consistency bug found during plan
    // review: if two docs both slugify to "notes", the second one's
    // repoPath becomes notes-2.md via dedupeRepoPath. Its pushed images
    // must land under assets/notes-2/ (matching what pull-side
    // docSlugFor("notes-2.md") will later derive from that same final
    // path) — not assets/notes/ (what slugifyDocName(doc.name) alone
    // would give), which pull could never resolve back correctly.
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "![x](img-1)", images: { "img-1": "data:image/png;base64,aGk=" } })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries);
    expect(plan.changes[0]!.repoPath).toBe("notes-2.md");
    expect(plan.changes[0]!.assets).toEqual([{ path: "assets/notes-2/img-1.png", dataUrl: "data:image/png;base64,aGk=" }]);
    expect(plan.changes[0]!.content).toBe("![x](assets/notes-2/img-1.png)");
  });
});
```

Change to:

```ts
describe("planPush", () => {
  it("assigns a new repoPath to a doc that has never synced", async () => {
    const docs = [fakeDoc({ id: "d1", name: "My Notes", repoPath: undefined })];
    const plan = await planPush(docs, [], false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("my-notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("adopts an existing tree path instead of deduping when a doc with no repoPath matches by name, and content is identical", async () => {
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    // sameWorkspace: false — identical content adopts quietly regardless
    // of the marker, proving this branch doesn't depend on it.
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("pushes directly to the matched tree path when content differs and sameWorkspace is true", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "new content" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, true);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("notes.md");
    expect(plan.conflicts).toEqual([]);
  });

  it("raises a conflict instead of overwriting when a matched tree path's content differs and sameWorkspace is false", async () => {
    const docs = [fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "new content" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "notes.md", remoteSha: "s1" }]);
  });

  it("dedupes a second doc's repoPath when the first already claimed the matching tree path", async () => {
    const docs = [
      fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "" }), // identical to tree -> quietly adopts notes.md
      fakeDoc({ id: "d2", name: "Notes", repoPath: undefined, content: "different content" }),
    ];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.docId).toBe("d2");
    expect(plan.changes[0]!.repoPath).toBe("notes-2.md");
  });

  it("skips a doc whose pushable content hashes to the tree's current blob sha", async () => {
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", content: "" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
  });

  it("pushes a doc whose content differs from the tree's current blob sha, even if repoSha still matches", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "changed locally" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toHaveLength(1);
  });

  it("queues a conflict when the tree's sha differs from the doc's last-known repoSha", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1" })];
    const entries: TreeEntry[] = [{ path: "a.md", sha: "s2", type: "blob" }];
    const plan = await planPush(docs, entries, false);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([{ docId: "d1", repoPath: "a.md", remoteSha: "s2" }]);
  });

  it("pushes a doc whose repoPath is not in the tree at all yet (first push after linking)", async () => {
    const docs = [fakeDoc({ id: "d1", repoPath: "a.md", repoSha: "s1", content: "hi" })];
    const plan = await planPush(docs, [], false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.repoPath).toBe("a.md");
  });

  it("uses the final (deduped) repoPath's own stem as the images-folder slug, not doc.name's slug", async () => {
    // Regression coverage for a slug-consistency bug found during plan
    // review: if two docs both slugify to "notes" (and neither matches
    // anything already in the tree), the second one's repoPath becomes
    // notes-2.md via dedupeRepoPath. Its pushed images must land under
    // assets/notes-2/ (matching what pull-side docSlugFor("notes-2.md")
    // will later derive from that same final path) — not assets/notes/
    // (what slugifyDocName(doc.name) alone would give), which pull could
    // never resolve back correctly.
    const docs = [
      fakeDoc({ id: "d1", name: "Notes", repoPath: undefined, content: "first" }),
      fakeDoc({ id: "d2", name: "Notes", repoPath: undefined, content: "![x](img-1)", images: { "img-1": "data:image/png;base64,aGk=" } }),
    ];
    const plan = await planPush(docs, [], false);
    const second = plan.changes.find((c) => c.docId === "d2")!;
    expect(second.repoPath).toBe("notes-2.md");
    expect(second.assets).toEqual([{ path: "assets/notes-2/img-1.png", dataUrl: "data:image/png;base64,aGk=" }]);
    expect(second.content).toBe("![x](assets/notes-2/img-1.png)");
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `planPush` doesn't accept a third argument yet, and the old dedupe-based assertions no longer hold.

- [ ] **Step 7: Implement `planPush`'s adoption logic**

In `client/src/repo-sync.ts`, find:

```ts
export async function planPush(docs: Doc[], mdEntries: TreeEntry[]): Promise<PushPlan> {
  const plan: PushPlan = { changes: [], deletions: [], conflicts: [] };
  const treeShaByPath = new Map(mdEntries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const usedPaths = new Set(mdEntries.map((e) => e.path));

  for (const doc of docs) {
    let repoPath = doc.repoPath;
    let isNewPath = false;
    if (!repoPath) {
      const base = `${slugifyDocName(doc.name)}.md`;
      repoPath = dedupeRepoPath(base, usedPaths);
      usedPaths.add(repoPath);
      isNewPath = true;
    } else {
      const treeSha = treeShaByPath.get(repoPath);
      if (treeSha !== undefined && treeSha !== doc.repoSha) {
        plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeSha });
        continue;
      }
    }
    const { content, assets } = rewriteImagesForPush(doc.content, slugFromRepoPath(repoPath), doc.images, doc.diagrams);
    if (!isNewPath) {
      const currentSha = treeShaByPath.get(repoPath);
      if (currentSha !== undefined && (await gitBlobSha(content)) === currentSha) continue;
    }
    plan.changes.push({ docId: doc.id, repoPath, content, assets });
  }

  return plan;
}
```

Change to:

```ts
export async function planPush(docs: Doc[], mdEntries: TreeEntry[], sameWorkspace: boolean): Promise<PushPlan> {
  const plan: PushPlan = { changes: [], deletions: [], conflicts: [] };
  const treeShaByPath = new Map(mdEntries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const usedPaths = new Set(mdEntries.map((e) => e.path));
  // Paths already claimed by an earlier doc in THIS loop via a tree-name
  // match below — a second doc that happens to slugify to the same name
  // falls through to the normal dedupe-as-new path instead of also
  // claiming it.
  const claimedFromTree = new Set<string>();

  for (const doc of docs) {
    let repoPath = doc.repoPath;
    let isNewPath = false;
    let matchedExistingFile = false;
    if (!repoPath) {
      const base = `${slugifyDocName(doc.name)}.md`;
      // A doc with no repoPath (never pushed, or its link metadata was
      // reset by an unlink) might still correspond to a file the target
      // repo already has — re-linking to the same repo, or linking to a
      // different repo that happens to have a same-named file. Adopt
      // that path instead of blindly dedupe-renaming into a duplicate;
      // the content-diff check below (shared with already-linked docs)
      // decides what happens next.
      if (treeShaByPath.has(base) && !claimedFromTree.has(base)) {
        repoPath = base;
        claimedFromTree.add(base);
        matchedExistingFile = true;
      } else {
        repoPath = dedupeRepoPath(base, usedPaths);
        usedPaths.add(repoPath);
        isNewPath = true;
      }
    } else {
      const treeSha = treeShaByPath.get(repoPath);
      if (treeSha !== undefined && treeSha !== doc.repoSha) {
        plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeSha });
        continue;
      }
    }
    const { content, assets } = rewriteImagesForPush(doc.content, slugFromRepoPath(repoPath), doc.images, doc.diagrams);
    if (!isNewPath) {
      const currentSha = treeShaByPath.get(repoPath);
      if (currentSha !== undefined && (await gitBlobSha(content)) === currentSha) continue;
    }
    if (matchedExistingFile && !sameWorkspace) {
      // Unproven whose file this actually is — flag it the same way an
      // already-linked doc's own sha mismatch would, rather than
      // silently overwriting content that might belong to someone else.
      plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeShaByPath.get(repoPath)! });
      continue;
    }
    plan.changes.push({ docId: doc.id, repoPath, content, assets });
  }

  return plan;
}
```

- [ ] **Step 8: Run `planPush` tests to verify they pass**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: still some failures — `pushToRepo`'s own internal call to `planPush` and its `applyResolved` retry call both need updating (Step 9), and they're exercised by the `linkWorkspaceAndSync` describe block's tests. The `planPush` describe block's own tests should now PASS.

- [ ] **Step 9: Wire the marker into `pushToRepo`**

In `client/src/repo-sync.ts`, find:

```ts
export async function pushToRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  onProgress?: (message: string) => void
): Promise<{ plan: PushPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = await planPush(docs, entries);
  if (plan.changes.length > 0) {
    onProgress?.(`Pushing ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}…`);
  }

  async function sendChanges(changes: PushPlan["changes"]): Promise<void> {
    if (changes.length === 0) return;
    const blobs: { path: string; contentBase64: string }[] = [];
    for (const change of changes) {
      blobs.push({ path: change.repoPath, contentBase64: toBase64(change.content) });
      for (const asset of change.assets) blobs.push({ path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl) });
    }
```

Change to:

```ts
export async function pushToRepo(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string },
  onProgress?: (message: string) => void
): Promise<{ plan: PushPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const sameWorkspace = await checkWorkspaceMarker(repoLink, entries, workspaceId);
  const plan = await planPush(docs, entries, sameWorkspace);
  if (plan.changes.length > 0) {
    onProgress?.(`Pushing ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}…`);
  }

  async function sendChanges(changes: PushPlan["changes"]): Promise<void> {
    if (changes.length === 0) return;
    const blobs: { path: string; contentBase64: string }[] = [];
    for (const change of changes) {
      blobs.push({ path: change.repoPath, contentBase64: toBase64(change.content) });
      for (const asset of change.assets) blobs.push({ path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl) });
    }
    const workspace = get(workspacesStore).find((w) => w.id === workspaceId);
    if (workspace) {
      const marker: WorkspaceMarker = { workspaceId: workspace.id, name: workspace.name };
      blobs.push({ path: WORKSPACE_MARKER_PATH, contentBase64: toBase64(JSON.stringify(marker)) });
    }
```

Now find the `applyResolved` retry call inside the same function:

```ts
  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const winningDocs = plan.conflicts.filter((c) => resolutions[c.docId] === "mine").map((c) => docs.find((d) => d.id === c.docId)!);
    const retryPlan = await planPush(winningDocs, []);
    await sendChanges(retryPlan.changes);
  }
```

Change to:

```ts
  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const winningDocs = plan.conflicts.filter((c) => resolutions[c.docId] === "mine").map((c) => docs.find((d) => d.id === c.docId)!);
    // sameWorkspace is unused here — the empty tree means matchedExistingFile
    // can never become true in this retry, so its value doesn't affect anything.
    const retryPlan = await planPush(winningDocs, [], true);
    await sendChanges(retryPlan.changes);
  }
```

Finally, add `checkWorkspaceMarker` right after `pushToRepo`'s closing brace (before `export type CreateFromRepoPlan = ...`):

```ts
// Reads .mde/workspace.json from the target repo's tree (if present) and
// reports whether it names THIS workspace — see markerMatchesWorkspace's
// own comment for what "matches" means. Used by pushToRepo to decide
// (via planPush) whether a name-matched-but-content-differing doc should
// push directly or raise a conflict.
async function checkWorkspaceMarker(
  repoLink: { owner: string; repo: string; branch: string },
  entries: TreeEntry[],
  workspaceId: string
): Promise<boolean> {
  const markerEntry = entries.find((e) => e.type === "blob" && e.path === WORKSPACE_MARKER_PATH);
  if (!markerEntry) return false;
  const blobRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/blob/${markerEntry.sha}`);
  if (!blobRes.ok) return false;
  const blobData = await blobRes.json();
  const content = blobData.encoding === "base64" ? atob(blobData.content.replace(/\n/g, "")) : blobData.content;
  return markerMatchesWorkspace(content, workspaceId);
}
```

- [ ] **Step 10: Run the full repo-sync test file to verify it passes**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests, including the pre-existing `linkWorkspaceAndSync` describe block's first test — its docs never match any tree path by name, so it's unaffected by this task).

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: adopt existing repo files by name instead of dedupe-renaming into duplicates"
```

---

### Task 2: `linkWorkspaceAndSync` surfaces push conflicts

**Files:**
- Modify: `client/src/repo-sync.ts`
- Modify: `client/src/components/RepoLinkModal.svelte`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `pushToRepo`, `pullFromRepo`, `setWorkspaceRepoLink`, `clearRepoSyncMetadata`, `repoSyncBusyLabel`, `showProgressToast`, `updateProgressToast`, `finishProgressToast` (all already imported/defined in `repo-sync.ts`).
- Produces: `LinkAndSyncResult` (discriminated union type, replacing the old single-shape interface) — `{ kind: "push-conflict"; pushPlan: PushPlan; applyPushResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>; progressToastId: number }` or `{ kind: "pull-result"; pullPlan: PullPlan; applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>; progressToastId: number }`.

- [ ] **Step 1: Write the failing tests**

In `client/src/repo-sync.test.ts`, find the `describe("linkWorkspaceAndSync", ...)` block's two existing tests:

```ts
  it("pushes local docs and pulls in the repo's pre-existing content, without touching it", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "pre-existing" }]);
    const ws = createWorkspace("Test Workspace");
    docsStore.set([{ id: "local-1", name: "Local Doc", content: "my local content", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    expect(typeof result.progressToastId).toBe("number");

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

    expect(typeof result.progressToastId).toBe("number");
    expect(result.pullPlan.conflicts).toEqual([]);
    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(2);

    const staleDoc = docs.find((d) => d.id === "stale-doc")!;
    expect(staleDoc.repoPath).toBe("notes-2.md"); // deduped against the repo's own notes.md
    expect(staleDoc.content).toBe("old content from a different repo");

    const pulledDoc = docs.find((d) => d.repoPath === "notes.md")!;
    expect(pulledDoc.content).toBe("fresh content from the new repo");
  });
```

Change to:

```ts
  it("pushes local docs and pulls in the repo's pre-existing content, without touching it", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "pre-existing" }]);
    const ws = createWorkspace("Test Workspace");
    docsStore.set([{ id: "local-1", name: "Local Doc", content: "my local content", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });
    expect(result.kind).toBe("pull-result");
    if (result.kind !== "pull-result") throw new Error("unreachable");
    expect(typeof result.progressToastId).toBe("number");

    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(2);

    const localDoc = docs.find((d) => d.id === "local-1")!;
    expect(localDoc.repoPath).toBeDefined();
    expect(localDoc.repoSha).toBeDefined();

    const pulledDoc = docs.find((d) => d.repoPath === "existing.md");
    expect(pulledDoc).toBeDefined();
    expect(pulledDoc!.content).toBe("pre-existing");
  });

  it("flags a push conflict instead of silently duplicating when relinking to a different repo with a same-named, differing-content file", async () => {
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

    expect(result.kind).toBe("push-conflict");
    if (result.kind !== "push-conflict") throw new Error("unreachable");
    expect(result.pushPlan.conflicts).toHaveLength(1);
    expect(result.pushPlan.conflicts[0]!.docId).toBe("stale-doc");
    expect(result.pushPlan.conflicts[0]!.repoPath).toBe("notes.md");

    // Nothing pushed or pulled yet — the doc keeps its (now
    // stale-metadata-cleared) content, and the repo's own notes.md is
    // untouched, until the conflict is explicitly resolved.
    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    expect(docs.length).toBe(1);
    expect(docs[0]!.content).toBe("old content from a different repo");
  });

  it("pushes directly instead of conflicting when relinking to a repo this exact workspace already pushed to before", async () => {
    const ws = createWorkspace("Test Workspace 3");
    backend.seedRepo("alice", "notes", "main", [
      { path: "notes.md", content: "old content from before" },
      { path: ".mde/workspace.json", content: JSON.stringify({ workspaceId: ws.id, name: ws.name }) },
    ]);
    docsStore.set([{ id: "my-doc", name: "Notes", content: "updated local content", updatedAt: 1, createdAt: 1, workspaceId: ws.id }]);

    const result = await linkWorkspaceAndSync(ws.id, { owner: "alice", repo: "notes", branch: "main" });

    expect(result.kind).toBe("pull-result");
    const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
    const doc = docs.find((d) => d.id === "my-doc")!;
    expect(doc.repoPath).toBe("notes.md");
    expect(doc.content).toBe("updated local content");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `result.kind` doesn't exist yet on the old `LinkAndSyncResult` shape.

- [ ] **Step 3: Implement the discriminated union**

In `client/src/repo-sync.ts`, find:

```ts
export interface LinkAndSyncResult {
  pullPlan: PullPlan;
  applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
  progressToastId: number;
}

// Push conflicts can never happen here: clearRepoSyncMetadata (above)
// strips every doc's repoPath first, and planPush only ever raises a
// conflict when a doc already has one — so the push step's own plan is
// safe to discard. Pull conflicts, on the other hand, are possible (the
// tree could move between the push and pull calls below) and are
// returned to the caller to route through the shared repoConflictModal,
// exactly like the manual "Pull from Repo" action already does.
//
// The returned toast is never finished with success here — only ever
// with an error, before rethrowing, so a thrown failure never leaves a
// stale "Pushing…"/"Pulling…" toast on screen. The success case is the
// caller's call: it still has to decide between "show success" and
// "conflicts found, open the resolution modal instead," and finishing
// this toast with a premature success message would be misleading in
// the second case.
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  repoSyncBusyLabel.set("Pushing…");
  const progressToastId = showProgressToast("Pushing…");
  const onProgress = (message: string) => updateProgressToast(progressToastId, message);
  try {
    await pushToRepo(workspaceId, repoLink, onProgress);
    repoSyncBusyLabel.set("Pulling…");
    const { plan, applyResolved } = await pullFromRepo(workspaceId, repoLink, new Set(), onProgress);
    return { pullPlan: plan, applyPullResolved: applyResolved, progressToastId };
  } catch (err) {
    finishProgressToast(progressToastId, err instanceof Error ? err.message : "Sync failed", "error");
    throw err;
  }
}
```

Change to:

```ts
export type LinkAndSyncResult =
  | { kind: "push-conflict"; pushPlan: PushPlan; applyPushResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>; progressToastId: number }
  | { kind: "pull-result"; pullPlan: PullPlan; applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>; progressToastId: number };

// A push conflict CAN happen here now: planPush's tree-name-match path
// (see its own comment) can raise one even for a doc with no repoPath,
// which clearRepoSyncMetadata (above) guarantees every doc has right
// before this runs. When it does, pull is skipped for this operation —
// the caller shows the push-conflict modal, and the user resolves it
// (or separately triggers "Pull from Repo" afterward) rather than this
// function chaining an automatic pull that could itself raise a second,
// cascading conflict modal.
//
// The returned toast is never finished with success here — only ever
// with an error, before rethrowing, so a thrown failure never leaves a
// stale "Pushing…"/"Pulling…" toast on screen. The success case is the
// caller's call: it still has to decide between "show success" and
// "conflicts found, open the resolution modal instead," and finishing
// this toast with a premature success message would be misleading in
// the second case.
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<LinkAndSyncResult> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  repoSyncBusyLabel.set("Pushing…");
  const progressToastId = showProgressToast("Pushing…");
  const onProgress = (message: string) => updateProgressToast(progressToastId, message);
  try {
    const { plan: pushPlan, applyResolved: applyPushResolved } = await pushToRepo(workspaceId, repoLink, onProgress);
    if (pushPlan.conflicts.length > 0) {
      return { kind: "push-conflict", pushPlan, applyPushResolved, progressToastId };
    }
    repoSyncBusyLabel.set("Pulling…");
    const { plan: pullPlan, applyResolved: applyPullResolved } = await pullFromRepo(workspaceId, repoLink, new Set(), onProgress);
    return { kind: "pull-result", pullPlan, applyPullResolved, progressToastId };
  } catch (err) {
    finishProgressToast(progressToastId, err instanceof Error ? err.message : "Sync failed", "error");
    throw err;
  }
}
```

- [ ] **Step 4: Run repo-sync tests to verify they pass**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Update `RepoLinkModal.svelte`'s caller**

In `client/src/components/RepoLinkModal.svelte`, find:

```ts
  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    try {
      const { pullPlan, applyPullResolved, progressToastId } = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      close();
      if (pullPlan.conflicts.length > 0 || pullPlan.deletions.length > 0) {
        dismissToast(progressToastId);
        repoConflictState.set({
          kind: "pull",
          conflicts: pullPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: pullPlan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(workspaceId, d.docId), repoPath: d.repoPath })),
          onResolve: applyPullResolved,
        });
        repoConflictModalOpen.set(true);
      } else {
        finishProgressToast(progressToastId, `Linked to ${owner}/${repo}`, "success");
      }
    } catch (err: any) {
      // linkWorkspaceAndSync already finished the progress toast as an
      // error before rethrowing — nothing left to show here.
    } finally {
      repoSyncBusyLabel.set(null);
    }
  }
```

Change to:

```ts
  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    try {
      const result = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      close();
      if (result.kind === "push-conflict") {
        dismissToast(result.progressToastId);
        repoConflictState.set({
          kind: "push",
          conflicts: result.pushPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: [],
          onResolve: result.applyPushResolved,
        });
        repoConflictModalOpen.set(true);
        return;
      }
      const { pullPlan, applyPullResolved, progressToastId } = result;
      if (pullPlan.conflicts.length > 0 || pullPlan.deletions.length > 0) {
        dismissToast(progressToastId);
        repoConflictState.set({
          kind: "pull",
          conflicts: pullPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: pullPlan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(workspaceId, d.docId), repoPath: d.repoPath })),
          onResolve: applyPullResolved,
        });
        repoConflictModalOpen.set(true);
      } else {
        finishProgressToast(progressToastId, `Linked to ${owner}/${repo}`, "success");
      }
    } catch (err: any) {
      // linkWorkspaceAndSync already finished the progress toast as an
      // error before rethrowing — nothing left to show here.
    } finally {
      repoSyncBusyLabel.set(null);
    }
  }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add client/src/repo-sync.ts client/src/components/RepoLinkModal.svelte client/src/repo-sync.test.ts
git commit -m "feat: surface push conflicts from linkWorkspaceAndSync instead of discarding them"
```

---

### Task 3: No unwanted initial commit on new repos

**Files:**
- Modify: `src/github-repo.ts`
- Modify: `src/test-support/fake-github-server.ts`
- Test: `src/github-repo.test.ts`

**Interfaces:**
- None new — this task changes internal behavior of `handleRepoCreate`, `handleRepoTree`, and `handleRepoPush` without changing their exported signatures or call sites (`src/worker.ts`'s routing is unaffected).

- [ ] **Step 1: Write the failing `handleRepoCreate` test**

In `src/github-repo.test.ts`, find:

```ts
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
```

Change to:

```ts
  it("creates a repo with the requested visibility, without auto-initializing it", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ name: "notes", private: true, auto_init: false });
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
```

- [ ] **Step 2: Write the failing `handleRepoTree` empty-repo test**

In `src/github-repo.test.ts`, add this test at the end of the `describe("handleRepoTree", ...)` block:

```ts
  it("returns an empty tree instead of an error when the branch has no commits yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://api.github.com/repos/alice/notes/git/refs/heads/main") {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoTree(req, fakeEnv, "alice", "notes", "main");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ commitSha: null, treeSha: null, tree: [] });
  });
```

- [ ] **Step 3: Write the failing `handleRepoPush` first-commit tests**

In `src/github-repo.test.ts`, add these tests at the end of the `describe("handleRepoPush", ...)` block (the one using `vi.stubGlobal` mocks, not the "against a real fake GitHub server" block):

```ts
  it("builds a first commit (no base_tree, no parents) and creates the ref via POST when baseTreeSha/parentCommitSha are both absent", async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method: init?.method || "GET", body });
        if (url.endsWith("/git/blobs")) return new Response(JSON.stringify({ sha: "blob-sha" }), { status: 201 });
        if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "new-tree-sha" }), { status: 201 });
        if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "new-commit-sha" }), { status: 201 });
        if (url.endsWith("/git/refs")) return new Response(JSON.stringify({ ref: "refs/heads/main", object: { sha: "new-commit-sha" } }), { status: 201 });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ branch: "main", blobs: [{ path: "a.md", contentBase64: "aGVsbG8=" }], deletePaths: [] }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(200);

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(treeCall.body.base_tree).toBeUndefined();
    const commitCall = calls.find((c) => c.url.endsWith("/git/commits"))!;
    expect(commitCall.body.parents).toBeUndefined();
    const refCall = calls.find((c) => c.url.endsWith("/git/refs"))!;
    expect(refCall.method).toBe("POST");
    expect(refCall.body).toEqual({ ref: "refs/heads/main", sha: "new-commit-sha" });
  });

  it("returns 400 when exactly one of baseTreeSha/parentCommitSha is present", async () => {
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ branch: "main", baseTreeSha: "base-tree", blobs: [], deletePaths: [] }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 4: Write the failing end-to-end test against the real fake GitHub server**

In `src/github-repo.test.ts`, add this test inside the existing `describe("handleRepoPush against a real fake GitHub server", ...)` block, after its one existing test:

```ts
  it("pushes a genuine first commit to a brand-new (never-seeded) repo with no prior ref", async () => {
    const cookie = await sessionCookieHeader("tok", "alice");
    // No seedRepo call — getRepo() lazily creates empty state, matching a
    // freshly-created (no longer auto_init'd) real GitHub repo exactly.

    const treeReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const treeRes = await handleRepoTree(treeReq, fakeEnv, "alice", "notes", "main");
    expect(treeRes.status).toBe(200);
    const treeData = (await treeRes.json()) as { commitSha: string | null; treeSha: string | null; tree: unknown[] };
    expect(treeData).toEqual({ commitSha: null, treeSha: null, tree: [] });

    const pushReq = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ branch: "main", blobs: [{ path: "notes.md", contentBase64: Buffer.from("hello").toString("base64") }], deletePaths: [] }),
    });
    const pushRes = await handleRepoPush(pushReq, fakeEnv, "alice", "notes");
    expect(pushRes.status).toBe(200);

    const followUpReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const followUpRes = await handleRepoTree(followUpReq, fakeEnv, "alice", "notes", "main");
    const followUpData = (await followUpRes.json()) as { tree: { path: string }[] };
    expect(followUpData.tree.map((e) => e.path)).toEqual(["notes.md"]);
  });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run src/github-repo.test.ts`
Expected: FAIL — `handleRepoCreate` still sends `auto_init: true`; `handleRepoTree` still proxies the 404; `handleRepoPush` still requires both `baseTreeSha`/`parentCommitSha` and always `PATCH`es; the fake GitHub server doesn't support `POST .../git/refs` yet.

- [ ] **Step 6: Update the fake GitHub server to support creating a new ref**

In `src/test-support/fake-github-server.ts`, find:

```ts
        if (req.method === "POST" && kind === "commits") {
          const body = JSON.parse(await readBody(req)) as { message: string; tree: string; parents: string[] };
          const sha = randomSha();
          state.commits.set(sha, { tree: body.tree, parents: body.parents });
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "PATCH" && kind === "refs" && parts[5] === "heads" && parts[6]) {
```

Change to:

```ts
        if (req.method === "POST" && kind === "commits") {
          const body = JSON.parse(await readBody(req)) as { message: string; tree: string; parents?: string[] };
          const sha = randomSha();
          state.commits.set(sha, { tree: body.tree, parents: body.parents || [] });
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "POST" && kind === "refs" && !parts[5]) {
          // Creating a brand-new ref (a repo's very first commit on a
          // branch that doesn't exist yet) — distinct from the PATCH
          // case below, which updates an existing ref.
          const body = JSON.parse(await readBody(req)) as { ref: string; sha: string };
          const branch = body.ref.replace(/^refs\/heads\//, "");
          state.refs.set(branch, body.sha);
          sendJson(res, 201, { ref: body.ref, object: { sha: body.sha } });
          return;
        }

        if (req.method === "PATCH" && kind === "refs" && parts[5] === "heads" && parts[6]) {
```

- [ ] **Step 7: Update `handleRepoCreate`**

In `src/github-repo.ts`, find:

```ts
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(session.token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
  });
```

Change to:

```ts
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(session.token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  });
```

- [ ] **Step 8: Update `handleRepoTree`**

In `src/github-repo.ts`, find:

```ts
  const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { headers });
  if (!refRes.ok) return proxyJson(refRes);
  const refData = await safeJson<{ object: { sha: string } }>(refRes);
```

Change to:

```ts
  const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { headers });
  if (refRes.status === 404) {
    // A freshly created repo (or any repo with no commits yet on this
    // branch) has no ref to resolve — this is a legitimate empty state,
    // not an error. handleRepoPush knows how to build a repo's very
    // first commit when it receives no baseTreeSha/parentCommitSha.
    return Response.json({ commitSha: null, treeSha: null, tree: [] });
  }
  if (!refRes.ok) return proxyJson(refRes);
  const refData = await safeJson<{ object: { sha: string } }>(refRes);
```

- [ ] **Step 9: Update `handleRepoPush`**

In `src/github-repo.ts`, find:

```ts
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
```

Change to:

```ts
  const branch = typeof body.branch === "string" ? body.branch : "";
  // baseTreeSha (a *tree* sha) becomes the new tree's base_tree below;
  // parentCommitSha (a *commit* sha — the branch head's current commit,
  // distinct from its tree) becomes the new commit's parents[0]. Mixing
  // these up produces a commit whose parent doesn't match its own tree's
  // base, which the ref-update step below would then reject. Both empty
  // together means "this repo/branch has no commits yet" —
  // handleRepoTree returns them as null/empty in exactly that case (see
  // its own comment). One present without the other is a client bug,
  // not a legitimate empty-repo push, so it's still rejected below.
  const baseTreeSha = typeof body.baseTreeSha === "string" ? body.baseTreeSha : "";
  const parentCommitSha = typeof body.parentCommitSha === "string" ? body.parentCommitSha : "";
  const blobs = Array.isArray(body.blobs) ? (body.blobs as { path: string; contentBase64: string }[]) : [];
  const deletePaths = Array.isArray(body.deletePaths) ? (body.deletePaths as string[]) : [];
  const isFirstCommit = !baseTreeSha && !parentCommitSha;
  if (!branch || (!isFirstCommit && (!baseTreeSha || !parentCommitSha))) {
    return new Response("branch is required, and baseTreeSha/parentCommitSha must both be present or both absent.", { status: 400 });
  }
```

Now find the tree-build, commit-create, and ref-update calls further down in the same function:

```ts
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
```

Change to:

```ts
  const treeEntries = computeNewTreeEntries(
    [],
    blobs.map((b) => ({ path: b.path, sha: blobShas[b.path]! })),
    deletePaths
  );
  const treeBody: { tree: typeof treeEntries; base_tree?: string } = { tree: treeEntries };
  if (!isFirstCommit) treeBody.base_tree = baseTreeSha;
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify(treeBody),
  });
  if (!treeRes.ok) return new Response(`Failed to build tree: ${await treeRes.text()}`, { status: 502 });
  const treeData = await safeJson<{ sha: string }>(treeRes);
  if (!treeData) return new Response("Failed to build tree: invalid response", { status: 502 });

  const commitBody: { message: string; tree: string; parents?: string[] } = { message: "Update from Markdown Editor", tree: treeData.sha };
  if (!isFirstCommit) commitBody.parents = [parentCommitSha];
  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify(commitBody),
  });
  if (!commitRes.ok) return new Response(`Failed to create commit: ${await commitRes.text()}`, { status: 502 });
  const commitData = await safeJson<{ sha: string }>(commitRes);
  if (!commitData) return new Response("Failed to create commit: invalid response", { status: 502 });

  // A first commit has no ref yet to update — it has to be created, not
  // patched. Any later push against the same branch always has
  // isFirstCommit false (handleRepoTree found a real ref by then), so
  // this only ever runs once per branch.
  const refRes = isFirstCommit
    ? await fetch(`${base}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitData.sha }),
      })
    : await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sha: commitData.sha, force: false }),
      });
  if (!refRes.ok) {
    return Response.json({ conflict: true, message: await refRes.text() }, { status: 409 });
  }
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run src/github-repo.test.ts`
Expected: PASS (all tests).

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 12: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/github-repo.ts src/test-support/fake-github-server.ts src/github-repo.test.ts
git commit -m "feat: push a repo's genuine first commit instead of auto-initializing with a placeholder"
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

This needs a real GitHub-authenticated session against the full `npm run dev` stack (Worker + GitHub OAuth), not `dev:client` alone:

- Create a brand-new repo from File > GitHub Repo > Open GitHub Repo as Workspace's "create new" option (or wherever this app's create-new-repo flow lives) with a workspace that has at least one document. Check the repo on GitHub afterward — confirm it has exactly one commit (the real content), not two (no auto-generated README/placeholder commit first).
- Link a workspace to a repo, then unlink it (File > GitHub Repo > Unlink Repo), then re-link it to the same repo. Confirm no duplicate files appear either in the repo on GitHub or in the local sidebar.
- Link a workspace to a different, pre-existing repo that has a file with the same name as one of the workspace's local documents but different content. Confirm the push-conflict modal appears (not a silent duplicate named `<name>-2.md`), and that choosing "mine" or "theirs" resolves it correctly.

If you can't run the full authenticated stack, flag this to the user rather than attempting it blind, same as the manual-verification notes on the previous two plans this session.
