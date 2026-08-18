# Portable Local History & Notes for Repo-Linked Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a repo-linked (not shared) document, make local version-history snapshots and personal notes travel with the repo instead of being stuck on whichever device created them.

**Architecture:** Every push bundles one more file per doc, `.mde/history/<slug>.json`, holding that doc's local snapshots (capped at 50, same as today) and notes — riding in the same commit as content, no new commits. It's fetched lazily (once per doc per session) the first time Version History or the Comments panel opens for that doc, then merged into local IndexedDB snapshots and `doc.notes` by id (union, never overwrite).

**Tech Stack:** TypeScript, Svelte 5, Vitest, fake-indexeddb (already a devDependency).

**Spec:** `docs/superpowers/specs/2026-08-19-repo-local-history-sync-design.md`

## Global Constraints

- Snapshots stay capped at 50 per doc (`MAX_SNAPSHOTS` in `history.ts`) after any merge.
- Merge is additive/union-only, deduped by `id` — never a delete-propagating sync.
- This applies only when `doc.repoPath` is set and the workspace is not shared.
- No new git commits: history/notes only ride along inside a push that's already happening.
- Fetching the companion file is lazy (on panel open), never during pull.

---

### Task 1: `history.ts` — export local snapshot reads, add repo-merge

**Files:**
- Modify: `client/src/history.ts`
- Test: `client/src/history.test.ts`

**Interfaces:**
- Consumes: nothing new (uses this file's own existing `getHistory`/`putHistory`/`MAX_SNAPSHOTS`).
- Produces: `export async function getHistory(docId: string): Promise<Snapshot[]>` (was private — same signature, just exported). `export async function mergeSnapshotsFromRepo(docId: string, remoteSnapshots: Snapshot[]): Promise<void>` — later tasks (3, 5) import both.

- [ ] **Step 1: Write the failing tests**

Add to `client/src/history.test.ts` (extend the existing import line and add a new `describe` block):

```ts
import { maybeSnapshotVersion, listVersions, getVersionContent, getVersionImages, restoreLocalVersion, deleteHistory, getHistory, mergeSnapshotsFromRepo } from "./history";
```

```ts
describe("mergeSnapshotsFromRepo", () => {
  it("adds remote snapshots the local device doesn't have yet", async () => {
    await maybeSnapshotVersion("doc-merge-add", "local v1", 1_000);
    await mergeSnapshotsFromRepo("doc-merge-add", [{ id: "remote-1", timestamp: 500, content: "remote v0" }]);
    const versions = await listVersions("doc-merge-add");
    expect(versions.map((v) => v.id).sort()).toEqual(expect.arrayContaining(["remote-1"]));
    expect(versions).toHaveLength(2);
  });

  it("does not duplicate a remote snapshot whose id already exists locally", async () => {
    await maybeSnapshotVersion("doc-merge-dupe", "v1", 1_000);
    const local = await getHistory("doc-merge-dupe");
    await mergeSnapshotsFromRepo("doc-merge-dupe", [local[0]!]);
    expect(await listVersions("doc-merge-dupe")).toHaveLength(1);
  });

  it("re-sorts by timestamp and re-caps at 50 after merging", async () => {
    for (let i = 0; i < 40; i++) {
      await maybeSnapshotVersion("doc-merge-cap", `v${i}`, 1_000 + i * 6 * 60 * 1000);
    }
    const remote = Array.from({ length: 20 }, (_, i) => ({
      id: `remote-${i}`,
      timestamp: 1_000 + (40 + i) * 6 * 60 * 1000,
      content: `remote v${i}`,
    }));
    await mergeSnapshotsFromRepo("doc-merge-cap", remote);
    const versions = await listVersions("doc-merge-cap");
    expect(versions).toHaveLength(50);
    // listVersions reverses to newest-first — the newest merged-in remote entry must survive the cap
    expect(versions[0]!.id).toBe("remote-19");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- history.test.ts`
Expected: FAIL — `getHistory` and `mergeSnapshotsFromRepo` are not exported yet.

- [ ] **Step 3: Implement**

In `client/src/history.ts`, change the existing private function to exported (find this exact line):

```ts
async function getHistory(docId: string): Promise<Snapshot[]> {
```

Replace with:

```ts
export async function getHistory(docId: string): Promise<Snapshot[]> {
```

Then add this new function right after `restoreLocalVersionContent` (before the `deleteHistory` export):

```ts
// Merges a repo-linked doc's companion history file (fetched by
// repo-history-sync.ts) into this device's local snapshots — union by
// id, re-sorted by time, re-capped at MAX_SNAPSHOTS. Never overwrites:
// a snapshot this device already has by id is left alone, so merging
// is safe to call repeatedly and never loses this device's own
// not-yet-pushed history.
export async function mergeSnapshotsFromRepo(docId: string, remoteSnapshots: Snapshot[]): Promise<void> {
  const local = await getHistory(docId);
  const byId = new Map(local.map((s) => [s.id, s]));
  for (const s of remoteSnapshots) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  const merged = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
  while (merged.length > MAX_SNAPSHOTS) merged.shift();
  await putHistory(docId, merged);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- history.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add client/src/history.ts client/src/history.test.ts
git commit -m "feat: merge repo-sourced local history snapshots into local IndexedDB"
```

---

### Task 2: `stores/docs.ts` — merge repo-sourced notes

**Files:**
- Modify: `client/src/stores/docs.ts`
- Test: `client/src/stores/docs.test.ts`

**Interfaces:**
- Consumes: this file's own existing `findDocById`, `updateDoc` (private, same file), `persistDocs`, and `Note` (already imported from `../types` — verify the import line already includes `Note`; `addDocNote` already uses the `Note` type so it is).
- Produces: `export function mergeDocNotes(docId: string, remoteNotes: Note[]): void` — Task 5 imports this.

- [ ] **Step 1: Write the failing test**

Add to `client/src/stores/docs.test.ts`, inside the existing `describe("docs store — workspace integration", ...)` block (following the file's existing `await import("./docs")`-per-test style):

```ts
  it("mergeDocNotes adds remote notes the doc doesn't have yet, by id", async () => {
    const { docsStore, mergeDocNotes } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Linked");
    docsStore.set([
      {
        id: "d1",
        name: "D1",
        content: "hello world",
        updatedAt: 1,
        createdAt: 1,
        workspaceId: ws.id,
        repoPath: "d1.md",
        notes: [{ id: "local-1", from: 0, to: 5, quote: "hello", orphaned: false, body: "local note", createdAt: 1 }],
      },
    ]);
    mergeDocNotes("d1", [{ id: "remote-1", from: 6, to: 11, quote: "world", orphaned: false, body: "remote note", createdAt: 2 }]);
    const doc = get(docsStore).find((d) => d.id === "d1");
    expect(doc?.notes?.map((n) => n.id).sort()).toEqual(["local-1", "remote-1"]);
  });

  it("mergeDocNotes does not duplicate a remote note whose id already exists locally", async () => {
    const { docsStore, mergeDocNotes } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Linked");
    const existing = { id: "n1", from: 0, to: 5, quote: "hello", orphaned: false, body: "note", createdAt: 1 };
    docsStore.set([{ id: "d1", name: "D1", content: "hello", updatedAt: 1, createdAt: 1, workspaceId: ws.id, repoPath: "d1.md", notes: [existing] }]);
    mergeDocNotes("d1", [existing]);
    const doc = get(docsStore).find((d) => d.id === "d1");
    expect(doc?.notes).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- docs.test.ts`
Expected: FAIL — `mergeDocNotes` is not exported from `./docs`.

- [ ] **Step 3: Implement**

In `client/src/stores/docs.ts`, add this new function right after `deleteDocNote`:

```ts
// Merges a repo-linked doc's companion history file (fetched by
// repo-history-sync.ts) into this device's notes — union by id, added
// notes appended, existing ones left untouched. A note's from/to/quote
// gets relocated at display time (CommentsPanel.svelte already calls
// relocateAnchor on every render), so a merged note needs no special
// position handling here.
export function mergeDocNotes(docId: string, remoteNotes: Note[]): void {
  const doc = findDocById(docId);
  if (!doc) return;
  const existingIds = new Set((doc.notes || []).map((n) => n.id));
  const toAdd = remoteNotes.filter((n) => !existingIds.has(n.id));
  if (toAdd.length === 0) return;
  updateDoc(docId, { notes: [...(doc.notes || []), ...toAdd] });
  persistDocs();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- docs.test.ts`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/docs.ts client/src/stores/docs.test.ts
git commit -m "feat: merge repo-sourced notes into a doc's local notes"
```

---

### Task 3: `repo-sync.ts` — plan history-file pushes and cleanup

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `Snapshot` type from `./history` (import, type-only), `Note` type from `./types` (add to existing `import type { Doc, Workspace } from "./types";` line).
- Produces: `export function historyPathFor(repoPath: string): string`. `PushPlan.historyChanges: { docId: string; historyPath: string; content: string }[]`. `planPush` gains a 5th parameter: `localHistory: Map<string, { snapshots: Snapshot[]; notes: Note[] }> = new Map()`. Task 4 (`pushToRepo`) builds this map and reads `plan.historyChanges`. Task 5 (`repo-history-sync.ts`) imports `historyPathFor`.

- [ ] **Step 1: Write the failing tests**

Add to `client/src/repo-sync.test.ts`, inside the existing `describe("planPush", ...)` block (after the last existing test, before its closing `});`):

```ts
  it("includes a historyChanges entry for a doc with local snapshots to push", async () => {
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const localHistory = new Map([["d1", { snapshots: [{ id: "snap-1", timestamp: 1, content: "old" }], notes: [] }]]);
    const plan = await planPush(docs, entries, false, [], localHistory);
    expect(plan.historyChanges).toHaveLength(1);
    expect(plan.historyChanges[0]!.historyPath).toBe(".mde/history/notes.json");
    expect(JSON.parse(plan.historyChanges[0]!.content)).toEqual({ snapshots: [{ id: "snap-1", timestamp: 1, content: "old" }], notes: [] });
  });

  it("emits historyChanges even when the doc's own content is unchanged", async () => {
    const bytes = new TextEncoder().encode("hi");
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const combined = new Uint8Array(header.length + bytes.length);
    combined.set(header);
    combined.set(bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", combined);
    const contentSha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: contentSha, content: "hi" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: contentSha, type: "blob" }];
    const localHistory = new Map([["d1", { snapshots: [], notes: [{ id: "n1", from: 0, to: 2, quote: "hi", orphaned: false, body: "b", createdAt: 1 }] }]]);
    const plan = await planPush(docs, entries, false, [], localHistory);
    expect(plan.changes).toEqual([]); // content itself unchanged — confirms this isn't just "content also happened to push"
    expect(plan.historyChanges).toHaveLength(1);
    expect(plan.historyChanges[0]!.historyPath).toBe(".mde/history/notes.json");
  });

  it("omits historyChanges for a doc with no local snapshots or notes", async () => {
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [{ path: "notes.md", sha: "s1", type: "blob" }];
    const plan = await planPush(docs, entries, false, [], new Map([["d1", { snapshots: [], notes: [] }]]));
    expect(plan.historyChanges).toEqual([]);
  });

  it("skips historyChanges when the pushed content matches the tree exactly", async () => {
    const docs = [fakeDoc({ id: "d1", name: "notes", repoPath: "notes.md", repoSha: "s1", content: "hi" })];
    const snapshots = [{ id: "snap-1", timestamp: 1, content: "old" }];
    const historyContent = JSON.stringify({ snapshots, notes: [] });
    const bytes = new TextEncoder().encode(historyContent);
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const combined = new Uint8Array(header.length + bytes.length);
    combined.set(header);
    combined.set(bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", combined);
    const sha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const entries: TreeEntry[] = [
      { path: "notes.md", sha: "s1", type: "blob" },
      { path: ".mde/history/notes.json", sha, type: "blob" },
    ];
    const plan = await planPush(docs, entries, false, [], new Map([["d1", { snapshots, notes: [] }]]));
    expect(plan.historyChanges).toEqual([]);
  });

  it("deletes a renamed doc's old history file alongside its old content path", async () => {
    const docs = [fakeDoc({ id: "d1", name: "New Name", repoPath: "old-name.md", repoSha: "s1", content: "hi" })];
    const entries: TreeEntry[] = [
      { path: "old-name.md", sha: "s1", type: "blob" },
      { path: ".mde/history/old-name.json", sha: "hist-sha", type: "blob" },
    ];
    const plan = await planPush(docs, entries, false);
    expect(plan.deletions).toEqual(expect.arrayContaining(["old-name.md", ".mde/history/old-name.json"]));
  });

  it("deletes a removed doc's history file via pendingRepoDeletions, same as its content path", async () => {
    const entries: TreeEntry[] = [
      { path: "gone.md", sha: "s1", type: "blob" },
      { path: ".mde/history/gone.json", sha: "hist-sha", type: "blob" },
    ];
    const plan = await planPush([], entries, false, ["gone.md"]);
    expect(plan.deletions).toEqual(expect.arrayContaining(["gone.md", ".mde/history/gone.json"]));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- repo-sync.test.ts`
Expected: FAIL — `plan.historyChanges` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Implement**

In `client/src/repo-sync.ts`:

1. Extend the type-only import at the top of the file:

```ts
import type { Doc, Workspace } from "./types";
```

becomes:

```ts
import type { Doc, Workspace, Note } from "./types";
import type { Snapshot } from "./history";
```

2. Add `historyPathFor` right after `slugFromRepoPath` (which it depends on):

```ts
// .mde/history/<slug>.json — one companion file per doc holding its
// local-only version-history snapshots and personal notes (see
// docs/superpowers/specs/2026-08-19-repo-local-history-sync-design.md).
// Same slug as the assets/<slug>/ folder, so a rename keeps both paths
// in sync via the same rename/delete detection already in planPush.
export function historyPathFor(repoPath: string): string {
  return `.mde/history/${slugFromRepoPath(repoPath)}.json`;
}
```

3. Add `historyChanges` to `PushPlan`:

```ts
export interface PushPlan {
  changes: { docId: string; repoPath: string; content: string; assets: ImageAsset[] }[];
  historyChanges: { docId: string; historyPath: string; content: string }[];
  deletions: string[];
  conflicts: PushConflict[];
}
```

4. Replace the whole `planPush` function. Find this exact block (from its `export async function planPush` signature through its closing `return plan;\n}`):

```ts
export async function planPush(docs: Doc[], mdEntries: TreeEntry[], sameWorkspace: boolean, pendingRepoDeletions: string[] = []): Promise<PushPlan> {
  const plan: PushPlan = { changes: [], deletions: [], conflicts: [] };
  const treeShaByPath = new Map(mdEntries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const usedPaths = new Set(mdEntries.map((e) => e.path));
  // Paths already claimed by an earlier doc in THIS loop via a tree-name
  // match below — a second doc that happens to slugify to the same name
  // falls through to the normal dedupe-as-new path instead of also
  // claiming it.
  const claimedFromTree = new Set<string>();
  // Every repoPath some live doc ends up owning by the end of this push
  // (whether or not its content actually changed) — used below to make
  // sure a rename's old path, or a pendingRepoDeletions entry, isn't
  // deleted if some other doc has since reclaimed that exact path.
  const claimedPaths = new Set<string>();
  // Old paths vacated by a rename detected THIS push — safe to delete
  // outright (unlike pendingRepoDeletions, there's no "never pulled in"
  // ambiguity: the doc that owned this path still exists right now).
  const renameOldPaths: string[] = [];

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
      // Rename detection: the doc's current name no longer slugifies to
      // the path it was last pushed to. Move the file (write the new
      // path, orphan-delete the old one below) instead of silently
      // keeping content in sync at a filename that no longer matches —
      // skipped when the target path already belongs to some other real
      // tree file, since that's a genuine collision, not a rename; the
      // doc just falls through to updating its old path as before.
      const wantsSlug = slugifyDocName(doc.name);
      const renamedBase = `${wantsSlug}.md`;
      if (wantsSlug !== slugFromRepoPath(repoPath) && !usedPaths.has(renamedBase)) {
        renameOldPaths.push(repoPath);
        repoPath = dedupeRepoPath(renamedBase, usedPaths);
        usedPaths.add(repoPath);
        isNewPath = true;
      } else {
        const treeSha = treeShaByPath.get(repoPath);
        if (treeSha !== undefined && treeSha !== doc.repoSha) {
          plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeSha });
          claimedPaths.add(repoPath);
          continue;
        }
      }
    }
    const { content, assets } = rewriteImagesForPush(doc.content, slugFromRepoPath(repoPath), doc.images, doc.diagrams);
    if (!isNewPath) {
      const currentSha = treeShaByPath.get(repoPath);
      if (currentSha !== undefined && (await gitBlobSha(content)) === currentSha) {
        claimedPaths.add(repoPath);
        continue;
      }
    }
    if (matchedExistingFile && !sameWorkspace) {
      // Unproven whose file this actually is — flag it the same way an
      // already-linked doc's own sha mismatch would, rather than
      // silently overwriting content that might belong to someone else.
      plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeShaByPath.get(repoPath)! });
      claimedPaths.add(repoPath);
      continue;
    }
    claimedPaths.add(repoPath);
    plan.changes.push({ docId: doc.id, repoPath, content, assets });
  }

  const treePaths = new Set(filterMarkdownEntries(mdEntries).map((e) => e.path));
  for (const path of renameOldPaths) {
    if (treePaths.has(path) && !claimedPaths.has(path)) plan.deletions.push(path);
  }
  for (const path of pendingRepoDeletions) {
    if (treePaths.has(path) && !claimedPaths.has(path) && !plan.deletions.includes(path)) plan.deletions.push(path);
  }

  return plan;
}
```

With:

```ts
export async function planPush(
  docs: Doc[],
  mdEntries: TreeEntry[],
  sameWorkspace: boolean,
  pendingRepoDeletions: string[] = [],
  localHistory: Map<string, { snapshots: Snapshot[]; notes: Note[] }> = new Map()
): Promise<PushPlan> {
  const plan: PushPlan = { changes: [], historyChanges: [], deletions: [], conflicts: [] };
  const treeShaByPath = new Map(mdEntries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const usedPaths = new Set(mdEntries.map((e) => e.path));
  // Paths already claimed by an earlier doc in THIS loop via a tree-name
  // match below — a second doc that happens to slugify to the same name
  // falls through to the normal dedupe-as-new path instead of also
  // claiming it.
  const claimedFromTree = new Set<string>();
  // Every repoPath some live doc ends up owning by the end of this push
  // (whether or not its content actually changed) — used below to make
  // sure a rename's old path, or a pendingRepoDeletions entry, isn't
  // deleted if some other doc has since reclaimed that exact path.
  const claimedPaths = new Set<string>();
  // Old paths vacated by a rename detected THIS push — safe to delete
  // outright (unlike pendingRepoDeletions, there's no "never pulled in"
  // ambiguity: the doc that owned this path still exists right now).
  const renameOldPaths: string[] = [];

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
      // Rename detection: the doc's current name no longer slugifies to
      // the path it was last pushed to. Move the file (write the new
      // path, orphan-delete the old one below) instead of silently
      // keeping content in sync at a filename that no longer matches —
      // skipped when the target path already belongs to some other real
      // tree file, since that's a genuine collision, not a rename; the
      // doc just falls through to updating its old path as before.
      const wantsSlug = slugifyDocName(doc.name);
      const renamedBase = `${wantsSlug}.md`;
      if (wantsSlug !== slugFromRepoPath(repoPath) && !usedPaths.has(renamedBase)) {
        renameOldPaths.push(repoPath);
        repoPath = dedupeRepoPath(renamedBase, usedPaths);
        usedPaths.add(repoPath);
        isNewPath = true;
      } else {
        const treeSha = treeShaByPath.get(repoPath);
        if (treeSha !== undefined && treeSha !== doc.repoSha) {
          plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeSha });
          claimedPaths.add(repoPath);
          continue;
        }
      }
    }
    const { content, assets } = rewriteImagesForPush(doc.content, slugFromRepoPath(repoPath), doc.images, doc.diagrams);
    // Was a plain `continue` before history/notes needed independent
    // consideration — a doc whose CONTENT is unchanged can still have
    // new local snapshots or notes to push, so this no longer skips the
    // rest of the loop body. contentUnchanged reproduces the exact same
    // effect on plan.changes/plan.conflicts that the old continue had
    // (see the two guards below that now check it explicitly).
    let contentUnchanged = false;
    if (!isNewPath) {
      const currentSha = treeShaByPath.get(repoPath);
      if (currentSha !== undefined && (await gitBlobSha(content)) === currentSha) {
        contentUnchanged = true;
      }
    }
    if (matchedExistingFile && !sameWorkspace && !contentUnchanged) {
      // Unproven whose file this actually is — flag it the same way an
      // already-linked doc's own sha mismatch would, rather than
      // silently overwriting content that might belong to someone else.
      plan.conflicts.push({ docId: doc.id, repoPath, remoteSha: treeShaByPath.get(repoPath)! });
      claimedPaths.add(repoPath);
      continue;
    }
    claimedPaths.add(repoPath);
    if (!contentUnchanged) plan.changes.push({ docId: doc.id, repoPath, content, assets });

    const history = localHistory.get(doc.id);
    if (history && (history.snapshots.length > 0 || history.notes.length > 0)) {
      const historyPath = historyPathFor(repoPath);
      const historyContent = JSON.stringify({ snapshots: history.snapshots, notes: history.notes });
      const currentHistorySha = treeShaByPath.get(historyPath);
      if (currentHistorySha === undefined || (await gitBlobSha(historyContent)) !== currentHistorySha) {
        plan.historyChanges.push({ docId: doc.id, historyPath, content: historyContent });
      }
    }
  }

  const treePaths = new Set(filterMarkdownEntries(mdEntries).map((e) => e.path));
  for (const path of renameOldPaths) {
    if (treePaths.has(path) && !claimedPaths.has(path)) plan.deletions.push(path);
  }
  for (const path of pendingRepoDeletions) {
    if (treePaths.has(path) && !claimedPaths.has(path) && !plan.deletions.includes(path)) plan.deletions.push(path);
  }
  // Each deleted doc's companion history file (if it has one) is deleted
  // right alongside it — same slug-derived path as its assets/<slug>/
  // folder, so a rename or delete never leaves an orphaned history file.
  for (const mdPath of [...plan.deletions]) {
    const historyPath = historyPathFor(mdPath);
    if (treeShaByPath.has(historyPath) && !claimedPaths.has(historyPath) && !plan.deletions.includes(historyPath)) {
      plan.deletions.push(historyPath);
    }
  }

  return plan;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- repo-sync.test.ts`
Expected: PASS — all existing `planPush`/`pushToRepo` tests still pass unchanged (confirms the `contentUnchanged` refactor didn't alter existing behavior), plus the 6 new tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: plan per-doc history-file pushes and cleanup alongside content"
```

---

### Task 4: `repo-sync.ts` — push the history-file blobs

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `getHistory` from `./history` (Task 1). `plan.historyChanges` (Task 3).
- Produces: `pushToRepo` now includes each doc's companion history file in its push, when changed.

This file has **no existing `pushToRepo` test coverage** and does not use dynamic per-test `await import(...)` — `docsStore`, `createWorkspace`, `workspacesStore` are already imported statically at the top of the file, and pushes are tested end-to-end against a real local HTTP server via `startFakeRepoBackend()` (see the existing `describe("linkWorkspaceAndSync", ...)` block for the exact `beforeEach`/`afterEach` pattern: start the backend, rewrite `/api/repo`-prefixed `fetch` calls to it, stop it after). Mirror that pattern exactly, in a new `describe("pushToRepo", ...)` block.

- [ ] **Step 1: Write the failing test**

First, extend two import lines already at the top of `client/src/repo-sync.test.ts`. The existing named-import block from `./repo-sync`:

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
  decodeBase64Text,
  type TreeEntry,
} from "./repo-sync";
```

becomes:

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
  decodeBase64Text,
  pushToRepo,
  type TreeEntry,
} from "./repo-sync";
```

Add two new import lines right after it — `fake-indexeddb/auto` (this file has no IndexedDB polyfill yet; `maybeSnapshotVersion` needs one, the same way `history.test.ts` and `docs.test.ts` already set it up) and `maybeSnapshotVersion`:

```ts
import "fake-indexeddb/auto";
import { maybeSnapshotVersion } from "./history";
```

Then add this new `describe` block, following the existing `describe("linkWorkspaceAndSync", ...)` block (after its closing `});`):

```ts
describe("pushToRepo", () => {
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

  it("includes a doc's history-file blob in the push when it has local snapshots to push", async () => {
    // notes.md is deliberately NOT in the seeded repo — a genuinely new
    // file for this push, so there's no blob-sha mismatch to produce a
    // conflict and skip the doc (this test cares about the history
    // blob riding along, not planPush's own conflict-detection, which
    // Task 3's tests already cover directly).
    backend.seedRepo("acme", "docs", "main", [{ path: "README.md", content: "placeholder" }]);
    const ws = createWorkspace("Linked");
    docsStore.set([{ id: "d1", name: "notes", content: "hi", updatedAt: 1, createdAt: 1, workspaceId: ws.id, repoPath: "notes.md" }]);
    await maybeSnapshotVersion("d1", "hi", 1_000);

    await pushToRepo(ws.id, { owner: "acme", repo: "docs", branch: "main" });

    const treeRes = await fetch("/api/repo/acme/docs/tree?branch=main");
    const treeData = (await treeRes.json()) as { tree: { path: string }[] };
    expect(treeData.tree.some((e) => e.path === ".mde/history/notes.json")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- repo-sync.test.ts -t "includes a doc's history-file blob"`
Expected: FAIL — no `.mde/history/notes.json` path in the resulting tree (`pushToRepo` doesn't read local history yet).

- [ ] **Step 3: Implement**

In `client/src/repo-sync.ts`:

1. Add `getHistory` to the imports (it currently has none from `./history` — add a new import line right after the existing `import { showProgressToast, ... } from "./stores/toast";` line):

```ts
import { getHistory } from "./history";
```

2. In `pushToRepo`, find this line:

```ts
  const pendingRepoDeletions = get(workspacesStore).find((w) => w.id === workspaceId)?.pendingRepoDeletions || [];
  const plan = await planPush(docs, entries, sameWorkspace, pendingRepoDeletions);
```

Replace with:

```ts
  const pendingRepoDeletions = get(workspacesStore).find((w) => w.id === workspaceId)?.pendingRepoDeletions || [];
  // Best-effort: a device where IndexedDB is unavailable/blocked still
  // pushes content normally, just with nothing to bundle into history —
  // matches history.ts's own maybeSnapshotVersion try/catch philosophy.
  // Snapshot/Note are already imported as types in this file (Task 3's
  // `import type { Doc, Workspace, Note } from "./types";` and
  // `import type { Snapshot } from "./history";`) — reused here to match
  // planPush's own localHistory parameter type exactly.
  const localHistory = new Map<string, { snapshots: Snapshot[]; notes: Note[] }>();
  for (const doc of docs) {
    const snapshots = await getHistory(doc.id).catch((): Snapshot[] => []);
    localHistory.set(doc.id, { snapshots, notes: doc.notes || [] });
  }
  const plan = await planPush(docs, entries, sameWorkspace, pendingRepoDeletions, localHistory);
```

3. Find `sendChanges`'s signature and body:

```ts
  async function sendChanges(changes: PushPlan["changes"], deletePaths: string[] = []): Promise<void> {
    if (changes.length === 0 && deletePaths.length === 0) return;
    const blobs: { path: string; contentBase64: string }[] = [];
    for (const change of changes) {
      blobs.push({ path: change.repoPath, contentBase64: toBase64(change.content) });
      for (const asset of change.assets) blobs.push({ path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl) });
    }
```

Replace with:

```ts
  async function sendChanges(changes: PushPlan["changes"], deletePaths: string[] = [], historyChanges: PushPlan["historyChanges"] = []): Promise<void> {
    if (changes.length === 0 && deletePaths.length === 0 && historyChanges.length === 0) return;
    const blobs: { path: string; contentBase64: string }[] = [];
    for (const change of changes) {
      blobs.push({ path: change.repoPath, contentBase64: toBase64(change.content) });
      for (const asset of change.assets) blobs.push({ path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl) });
    }
    for (const historyChange of historyChanges) {
      blobs.push({ path: historyChange.historyPath, contentBase64: toBase64(historyChange.content) });
    }
```

4. Find the two call sites of `sendChanges` and `applyResolved`'s `planPush` retry call:

```ts
  await sendChanges(plan.changes, plan.deletions);
```

becomes:

```ts
  await sendChanges(plan.changes, plan.deletions, plan.historyChanges);
```

and:

```ts
  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const winningDocs = plan.conflicts.filter((c) => resolutions[c.docId] === "mine").map((c) => docs.find((d) => d.id === c.docId)!);
    // sameWorkspace is unused here — the empty tree means matchedExistingFile
    // can never become true in this retry, so its value doesn't affect anything.
    const retryPlan = await planPush(winningDocs, [], true);
    await sendChanges(retryPlan.changes);
  }
```

becomes:

```ts
  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const winningDocs = plan.conflicts.filter((c) => resolutions[c.docId] === "mine").map((c) => docs.find((d) => d.id === c.docId)!);
    // sameWorkspace is unused here — the empty tree means matchedExistingFile
    // can never become true in this retry, so its value doesn't affect anything.
    const retryPlan = await planPush(winningDocs, [], true, [], localHistory);
    await sendChanges(retryPlan.changes, [], retryPlan.historyChanges);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- repo-sync.test.ts`
Expected: PASS — the new `pushToRepo` test plus every existing `planPush`/`linkWorkspaceAndSync` test in the file (confirms the added `localHistory` map and `historyChanges` plumbing didn't change push behavior for docs with no local history).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (452+ tests, all files).

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: push each doc's history-file blob alongside its content"
```

---

### Task 5: `repo-history-sync.ts` — lazy fetch-and-merge

**Files:**
- Create: `client/src/repo-history-sync.ts`
- Test: `client/src/repo-history-sync.test.ts`

**Interfaces:**
- Consumes: `historyPathFor`, `decodeBase64Text` from `./repo-sync` (Task 3, already exists). `mergeSnapshotsFromRepo`, `Snapshot` (type) from `./history` (Task 1). `mergeDocNotes` from `./stores/docs` (Task 2). `workspacesStore` from `./stores/workspaces`. `Doc`, `Note` (type) from `./types`.
- Produces: `export async function fetchAndMergeRepoHistory(doc: Doc): Promise<void>`. `export function resetFetchedHistoryCache(): void` (test-only escape hatch — the module-level dedupe cache otherwise persists across tests in the same process). Tasks 6 and 7 (VersionHistory.svelte, CommentsPanel.svelte) import `fetchAndMergeRepoHistory`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/repo-history-sync.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { fetchAndMergeRepoHistory, resetFetchedHistoryCache } from "./repo-history-sync";
import { docsStore } from "./stores/docs";
import { createWorkspace, setWorkspaceRepoLink } from "./stores/workspaces";
import { getHistory } from "./history";
import type { Doc } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  resetFetchedHistoryCache();
});

function linkedDoc(overrides: Partial<Doc> = {}): Doc {
  const ws = createWorkspace("Linked");
  setWorkspaceRepoLink(ws.id, { owner: "acme", repo: "docs", branch: "main" });
  const doc: Doc = { id: "d1", name: "notes", content: "hi", updatedAt: 1, createdAt: 1, workspaceId: ws.id, repoPath: "notes.md", ...overrides };
  docsStore.set([doc]);
  return doc;
}

describe("fetchAndMergeRepoHistory", () => {
  it("does nothing for a doc with no repoPath", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await fetchAndMergeRepoHistory({ id: "d1", name: "n", content: "", updatedAt: 1, createdAt: 1, workspaceId: "w1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges remote snapshots and notes on a successful fetch", async () => {
    const doc = linkedDoc();
    const remote = {
      snapshots: [{ id: "remote-snap", timestamp: 500, content: "old" }],
      notes: [{ id: "remote-note", from: 0, to: 2, quote: "hi", orphaned: false, body: "b", createdAt: 500 }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ content: btoa(JSON.stringify(remote)), encoding: "base64" }), { status: 200 }))
    );
    await fetchAndMergeRepoHistory(doc);
    expect((await getHistory("d1")).map((s) => s.id)).toEqual(["remote-snap"]);
    // mergeDocNotes writes into docsStore directly — read it back the same way
    let notes: { id: string }[] | undefined;
    docsStore.subscribe((docs) => (notes = docs.find((d) => d.id === "d1")?.notes))();
    expect(notes?.map((n) => n.id)).toEqual(["remote-note"]);
  });

  it("does nothing (no throw) on a 404 — no companion file pushed yet", async () => {
    const doc = linkedDoc();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(fetchAndMergeRepoHistory(doc)).resolves.toBeUndefined();
    expect(await getHistory("d1")).toEqual([]);
  });

  it("only fetches once per doc per session even if called again", async () => {
    const doc = linkedDoc();
    const remote = { snapshots: [], notes: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: btoa(JSON.stringify(remote)), encoding: "base64" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAndMergeRepoHistory(doc);
    await fetchAndMergeRepoHistory(doc);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- repo-history-sync.test.ts`
Expected: FAIL — the module `./repo-history-sync` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `client/src/repo-history-sync.ts`:

```ts
// Lazily fetches and merges a repo-linked (not shared) doc's local-only
// companion history file — .mde/history/<slug>.json, written by
// repo-sync.ts's planPush/pushToRepo — into this device's local
// IndexedDB snapshots and doc.notes. See
// docs/superpowers/specs/2026-08-19-repo-local-history-sync-design.md.
//
// Fetched once per doc per session (not on every pull, and not every
// time a panel reopens), and shared between VersionHistory.svelte and
// CommentsPanel.svelte — the two panels that display this data — so
// whichever one opens first pays the cost and the other reuses it.
import { get } from "svelte/store";
import type { Doc, Note } from "./types";
import { workspacesStore } from "./stores/workspaces";
import { historyPathFor, decodeBase64Text } from "./repo-sync";
import { mergeSnapshotsFromRepo, type Snapshot } from "./history";
import { mergeDocNotes } from "./stores/docs";

const fetchedDocIds = new Set<string>();

// Test-only: the module-level cache above is intentionally session-
// lifetime (cleared by a page reload in production), but tests in the
// same process need to reset it between cases.
export function resetFetchedHistoryCache(): void {
  fetchedDocIds.clear();
}

export async function fetchAndMergeRepoHistory(doc: Doc): Promise<void> {
  if (!doc.repoPath || fetchedDocIds.has(doc.id)) return;
  fetchedDocIds.add(doc.id);
  const repoLink = get(workspacesStore).find((w) => w.id === doc.workspaceId)?.repoLink;
  if (!repoLink) return;
  const historyPath = historyPathFor(doc.repoPath);
  const encodedPath = historyPath.split("/").map(encodeURIComponent).join("/");
  let res: Response;
  try {
    res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(repoLink.branch)}`);
  } catch (err) {
    return;
  }
  if (!res.ok) return; // 404 = no companion file pushed yet; any other failure — best-effort, nothing to merge
  const data = (await res.json()) as { content: string; encoding: string };
  const raw = data.encoding === "base64" ? decodeBase64Text(data.content) : data.content;
  let parsed: { snapshots?: Snapshot[]; notes?: Note[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (parsed.snapshots?.length) await mergeSnapshotsFromRepo(doc.id, parsed.snapshots);
  if (parsed.notes?.length) mergeDocNotes(doc.id, parsed.notes);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- repo-history-sync.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-history-sync.ts client/src/repo-history-sync.test.ts
git commit -m "feat: lazily fetch and merge a repo-linked doc's companion history file"
```

---

### Task 6: Wire Version History and Comments panel

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`
- Modify: `client/src/components/CommentsPanel.svelte`

**Interfaces:**
- Consumes: `fetchAndMergeRepoHistory` from `../repo-history-sync` (Task 5).
- Produces: opening either panel for a repo-linked, not-shared doc triggers the fetch-and-merge before reading local data — end of the feature's data path, verified live in Task 7.

- [ ] **Step 1: Wire `VersionHistory.svelte`**

Add the import (alongside the file's existing `import { decodeBase64Text, slugFromRepoPath, type TreeEntry } from "../repo-sync";` line):

```ts
import { fetchAndMergeRepoHistory } from "../repo-history-sync";
```

Find `loadVersions`:

```ts
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
```

Replace with:

```ts
  async function loadVersions() {
    const doc = getActiveDoc();
    if (!doc) {
      versions = [];
      return;
    }
    const isShared = isDocShared(doc);
    restoreAllowed = !isShared || !window.MDE.getEditor().state.readOnly;
    loading = true;
    if (!isShared) await fetchAndMergeRepoHistory(doc);
    const localList = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
```

- [ ] **Step 2: Wire `CommentsPanel.svelte`**

Add the import (alongside the file's existing `import { activeIdStore, getActiveDoc, addDocNote, deleteDocNote } from "../stores/docs";` line):

```ts
import { fetchAndMergeRepoHistory } from "../repo-history-sync";
```

Find `loadEntries`'s not-shared branch:

```ts
    if (ctx.isShared) {
      const threads = await listComments(ctx.doc.workspaceId, ctx.doc.id);
      entries = threads.map((t) => ({ ...t, kind: "thread" as const }));
    } else {
      entries = (ctx.doc.notes || []).map((n) => ({ ...n, kind: "note" as const }));
    }
```

Replace with:

```ts
    if (ctx.isShared) {
      const threads = await listComments(ctx.doc.workspaceId, ctx.doc.id);
      entries = threads.map((t) => ({ ...t, kind: "thread" as const }));
    } else {
      await fetchAndMergeRepoHistory(ctx.doc);
      const freshDoc = getActiveDoc(); // re-read: fetchAndMergeRepoHistory may have just updated doc.notes
      entries = (freshDoc?.notes || []).map((n) => ({ ...n, kind: "note" as const }));
    }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p client/tsconfig.json && npx svelte-check --tsconfig client/tsconfig.json`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/VersionHistory.svelte client/src/components/CommentsPanel.svelte
git commit -m "feat: fetch and merge repo-linked docs' local history when either panel opens"
```

---

### Task 7: Live verification

**Files:** none (verification only).

- [ ] **Step 1: Start a local dev server**

```bash
npm run dev:client -- --port 5265
```

- [ ] **Step 2: Verify the push side**

In a browser tab, seed `localStorage` with a repo-linked doc (`repoPath` set, workspace with `repoLink`), and add a local snapshot and a note for it directly via the console (`history.ts`'s `maybeSnapshotVersion` and `docs.ts`'s `addDocNote`, both reachable via the app's existing module graph in dev mode, or by seeding IndexedDB/localStorage directly matching the shapes in this plan's tests). Stub `window.fetch` for `/api/repo/.../tree`, `/api/repo/.../push`, and `/api/repo/.../commits` (the same stubbing pattern used throughout this session's other live verifications). Trigger `window.MDE.pushToRepoAction()`. Confirm the captured push request's `blobs` array includes a `.mde/history/<slug>.json` entry containing the seeded snapshot and note.

- [ ] **Step 3: Verify the pull/merge side**

On a fresh seed (doc with `repoPath` set, no local snapshots/notes yet), stub `/api/repo/.../contents/.mde%2Fhistory%2F<slug>.json` (note: `historyPath.split("/").map(encodeURIComponent).join("/")` does NOT escape the `/` separators — the actual request path is `.../contents/.mde/history/<slug>.json`, not URL-escaped, matching this session's earlier documented `fetchCommitContent`/asset-fetch encoding pattern) to return a base64-encoded companion JSON with one snapshot and one note. Open Version History — confirm the seeded snapshot appears in the list. Open the Comments panel — confirm the seeded note appears. Reopen Version History again in the same session — confirm (via a request-count check) the companion file is not re-fetched.

- [ ] **Step 4: Clean up**

Close the browser tab, kill the dev server (`lsof -ti:5265 | xargs kill`).

- [ ] **Step 5: Report**

No commit — this task is verification only. Proceed to the finishing-a-development-branch skill.
