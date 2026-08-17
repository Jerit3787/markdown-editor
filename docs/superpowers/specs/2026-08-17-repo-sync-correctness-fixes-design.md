# Repo-Sync Correctness Fixes — Design Spec

**TODO items 11, 13, 17, 10.** Three repo-sync bugs found to share one
root cause, fixed together, plus the workspace-identity feature (item 10)
that resolves the one genuine ambiguity the fix runs into. Root causes
confirmed via `superpowers:systematic-debugging` against
`client/src/repo-sync.ts`, `client/src/repo-sync-ui.ts`,
`client/src/stores/docs.ts`, `client/src/stores/workspaces.ts`, and
`src/github-repo.ts`.

## Goal

Linking a workspace to a repo — whether re-linking to the same repo after
unlinking (item 11), or linking to a different existing repo that happens
to have same-named files (item 13) — never silently creates duplicate
files, on the repo or locally. Creating a brand-new repo from this app
never leaves an unwanted placeholder commit before the real content
lands (item 17). Workspace identity is recorded in the repo itself (item
10), giving the fix for 11/13 a reliable way to tell "this really is the
same workspace" from "unproven, could be someone else's file."

## Root causes

**11 + 13 share one root cause.** `window.MDE.unlinkRepo` →
`clearWorkspaceRepoLink` (`stores/workspaces.ts:104-107`) only clears the
workspace's `repoLink` field — it never touches each document's
`repoPath`/`repoSha`/`repoImageShas`. Re-linking (`linkWorkspaceAndSync`,
`repo-sync.ts:401-419`) then calls `clearRepoSyncMetadata` first, which
unconditionally wipes those fields from every doc in the workspace.
`planPush`'s `isNewPath` branch (`repo-sync.ts:236-265`, hit whenever a
doc has no `repoPath`) has no conflict detection against the target
repo's existing tree at all — it just calls `dedupeRepoPath`, which
silently renames into `notes-2.md` the moment the repo already has a file
at the doc's slugified path. For item 11, the repo still has the
*original* file (unlinking never deletes anything server-side), so the
next `pullFromRepo` finds it with no matching local doc and creates a
second local duplicate — producing duplicates on both sides from one bad
assumption.

**17 is a separate, server-side issue.** `handleRepoCreate`
(`src/github-repo.ts:20-38`) passes `auto_init: true` to GitHub's repo
creation API, producing an automatic README + initial commit + branch.
This exists only because `handleRepoPush` (`github-repo.ts:120-197`)
hard-requires a `baseTreeSha` and `parentCommitSha` to build on, and
`handleRepoTree` (`github-repo.ts:84-100`) needs an existing branch ref to
resolve those — neither exists on a genuinely empty repo. `RepoPicker.svelte`
creates the repo then immediately pushes real content on top via the same
`linkWorkspaceAndSync` flow, so every "create new repo" ends up with two
commits instead of one.

## Behavior

### 1. Workspace identity marker (item 10)

Every successful push writes `.mde/workspace.json` — `{ workspaceId,
name }` for the workspace being pushed — as one more blob alongside the
doc/image blobs already being sent. It participates in the same "skip if
nothing changed" logic as everything else (Git blobs are content-addressed,
so an unchanged marker produces no tree diff), so it costs nothing extra
on top of a push that's already happening. It is *not* written on a push
whose plan ends up with zero changes (an edge case — a workspace can only
ever fail to have its marker set by never actually pushing anything after
being linked, which self-corrects the next time anything real changes).

`client/src/repo-sync.ts` gains:

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
```

`pushToRepo` reads the marker (if present) from the tree it already
fetches, before planning, and writes the current workspace's marker as
part of the same push that already has other changes to send (see
Behavior section 4 for the exact integration).

### 2. `planPush` adopts existing tree paths instead of deduping into duplicates

`planPush` gains a third parameter, `sameWorkspace: boolean` — whether
`markerMatchesWorkspace` proved the target repo's marker names the
workspace being pushed. Its `isNewPath` branch changes from "always
dedupe as new" to "check the tree for an exact name match first":

- **No match in the tree:** unchanged — `dedupeRepoPath` as today.
- **Match found, pushable content is identical:** adopt the path
  silently — no push needed, no conflict, same as today's "content
  unchanged" skip for an already-linked doc.
- **Match found, content differs, `sameWorkspace` is true:** push the
  update to the adopted path directly — this workspace is *proven* to
  have owned that repo before, so a differing local copy is just an
  unpushed edit, not a competing claim.
- **Match found, content differs, `sameWorkspace` is false:** raise a
  push conflict (reusing the existing `PushConflict`/`repoConflictState`
  machinery) instead of silently overwriting content that might belong to
  someone else.

A second local doc that happens to slugify to the same name as an
already-adopted path still falls through to `dedupeRepoPath` against
`usedPaths` (which already contains every tree path, adopted or not) —
genuine multi-doc collisions between two of *your own* documents are
unaffected by this change.

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

`pushToRepo`'s `applyResolved` (its "mine" retry path) already calls
`planPush(winningDocs, [])` with an empty tree — that behavior is
unaffected (an empty tree means `treeShaByPath` is empty, so
`matchedExistingFile` can never become true there); it just needs the new
third argument (`true` — unused in this call since the tree is empty, see
inline comment).

### 3. `linkWorkspaceAndSync` surfaces push conflicts too

Before this fix, `linkWorkspaceAndSync`'s own comment asserted push
conflicts "can never happen here" (true under the old design — every doc
was always brand-new after `clearRepoSyncMetadata`, and only an
*already-linked* doc could conflict). That assumption no longer holds:
the new tree-match path in `planPush` can now raise a push conflict even
for a doc with no `repoPath`. `linkWorkspaceAndSync`'s return type
becomes a discriminated union so its caller can no longer silently
discard a push conflict the way the old single-shape `LinkAndSyncResult`
did:

```ts
export type LinkAndSyncResult =
  | { kind: "push-conflict"; pushPlan: PushPlan; applyPushResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>; progressToastId: number }
  | { kind: "pull-result"; pullPlan: PullPlan; applyPullResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>; progressToastId: number };

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

If push conflicts are found, pull is skipped entirely for this operation
— the user resolves the push conflict first (via the same
`RepoConflictModal.svelte` push's own manual "Push to Repo" action
already uses; it shows its own "Push complete" toast on resolve, so
nothing extra is needed there). Pulling anything else that may have
changed remotely is left to the existing, separate "Pull from Repo"
action — chaining an automatic pull after conflict resolution (which
could itself raise pull conflicts, cascading modals) is out of scope; see
Non-goals.

`RepoLinkModal.svelte`'s `linkWorkspace` branches on `result.kind`
instead of destructuring a single shape:

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

### 4. `pushToRepo` reads and writes the marker

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
    // ...unchanged from here (fetch branch tree, POST /push, setDocRepoLinkById per change)
  }

  await sendChanges(plan.changes);
  // ...applyResolved unchanged except its planPush call gains the new argument (see section 2)
  return { plan, applyResolved };
}

// Reads .mde/workspace.json from the target repo's tree (if present) and
// reports whether it names THIS workspace — see markerMatchesWorkspace's
// own comment for what "matches" means.
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

### 5. No unwanted initial commit on new repos

`handleRepoCreate` (`src/github-repo.ts`) drops `auto_init` from the
GitHub API call entirely (defaults to `false`) — new repos start with
zero commits and no branch ref.

`handleRepoTree` stops treating "no branch ref yet" as an error. Find:

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

`handleRepoPush` makes `baseTreeSha`/`parentCommitSha` optional and
branches on whether they were provided. Find:

```ts
  const branch = typeof body.branch === "string" ? body.branch : "";
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
  // Both empty together means "this repo/branch has no commits yet" —
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

Then the tree-build and commit-create calls omit `base_tree`/`parents`
respectively for the first commit, and the ref update uses `POST` (create)
instead of `PATCH` (update an existing ref). Find:

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

Client-side, `pullFromRepo`/`pushToRepo`'s `if (!treeRes.ok) throw new
Error(...)` guard is unaffected — `handleRepoTree` now returns `200` with
an empty tree for a genuinely empty repo instead of a `404`, so this
guard only ever fires for a real error.

## Non-goals (deferred)

- **Automatically chaining a pull after resolving a push conflict during
  link.** The user can already trigger "Pull from Repo" separately once
  the push conflict is resolved; chaining it automatically risks
  cascading a second conflict modal immediately after the first, which is
  a worse UX than a single extra manual step.
- **Cross-device workspace identity.** The marker's `workspaceId` is the
  purely-local id `stores/workspaces.ts` already generates (never synced
  between devices/browsers) — it reliably answers "did *this* local
  workspace record push here before," not "does the user, across every
  device, consider this their workspace." That distinction only matters
  for a scenario (the same conceptual workspace, opened fresh on a second
  device, linking to the same repo) this spec doesn't attempt to solve.
- **Retroactively backfilling the marker onto repos already linked before
  this ships.** The marker only gets written going forward, on the next
  successful push. An already-linked, already-synced repo with no
  unresolved conflicts is unaffected either way (`isNewPath` never
  triggers for docs that already have a `repoPath`); only a *future*
  unlink+relink cycle against such a repo benefits from having a marker
  in place by the time it happens.

## Error handling

`checkWorkspaceMarker` fails closed: any error reading or parsing the
marker (missing file, non-200 blob fetch, invalid JSON, wrong shape)
returns `false` — "not proven safe" — never `true`. A push conflict
raised by the new tree-match path uses the same error/toast plumbing the
existing SHA-mismatch conflict path already has (via
`RepoConflictModal.svelte`'s generic `onResolve` handling) — no new error
surface is introduced.

## Testing

- `repo-sync.test.ts`'s `markerMatchesWorkspace`: true for a marker whose
  `workspaceId` matches; false for a mismatched id, malformed JSON, and
  `null` content.
- `planPush`'s existing test suite needs several rewrites, not just
  additions, since two current tests assert the *old* dedupe-into-duplicate
  behavior as correct:
  - "dedupes a new repoPath against the current tree" is replaced by a
    test that matches the new adoption behavior: a doc with no `repoPath`
    whose slug matches an existing tree entry adopts that path (with
    `sameWorkspace: true` and identical pushable content, expect the doc
    to end up with that `repoPath` and `plan.changes` empty — nothing to
    push).
  - "uses the final (deduped) repoPath's own stem as the images-folder
    slug" is re-scoped to a genuine two-local-docs collision (both slugify
    to `notes.md`, neither matches anything in the tree) rather than a
    tree-match, preserving its original regression coverage (the second,
    deduped doc's images must use *its own* final path's slug) without
    relying on now-changed matched-path behavior.
  - New test: a doc with no `repoPath` matching an existing tree entry,
    `sameWorkspace: true`, content differs — expect a normal push to the
    adopted path (`plan.changes` has one entry at that path), not a
    conflict.
  - New test: same setup with `sameWorkspace: false` — expect a conflict
    (`plan.conflicts` has one entry, `plan.changes` empty), not a silently
    renamed duplicate.
  - New test: two docs both slugify to a tree-matched path — the first
    claims it (per whichever of the above rules applies), the second
    falls through to `dedupeRepoPath` against `usedPaths` and gets a
    distinct new path.
  - All pre-existing tests whose docs already have a `repoPath` set (the
    `else` branch, unaffected by this change) just need the call site
    updated to pass the new third `sameWorkspace` argument.
- `linkWorkspaceAndSync`'s existing "clears stale repo-sync metadata..."
  test is rewritten: it currently asserts the exact duplicate-creating
  behavior this spec removes (the stale doc's content genuinely differs
  from the new repo's `notes.md`, so under the new design — no marker
  present, since this repo has never been pushed to before — it must
  come back as `{ kind: "push-conflict", ... }` with a conflict naming
  `notes.md`, not a silent rename to `notes-2.md`).
- New `linkWorkspaceAndSync` test: re-linking to a repo this exact
  workspace already pushed to before (seed the fake repo backend with a
  `.mde/workspace.json` naming this workspace's id, plus a file whose
  content differs from the local doc) — expect `{ kind: "pull-result",
  ... }` (no push conflict) and the doc's content pushed through to that
  path.
- New `handleRepoCreate`/`handleRepoTree`/`handleRepoPush` tests in
  `src/github-repo.test.ts`: `handleRepoCreate`'s request body to GitHub
  no longer includes `auto_init: true` (or includes it as `false`);
  `handleRepoTree` against a 404 ref lookup returns `200` with
  `{ commitSha: null, treeSha: null, tree: [] }` instead of proxying the
  404; `handleRepoPush` with both `baseTreeSha`/`parentCommitSha` omitted
  builds a tree with no `base_tree`, a commit with no `parents`, and
  creates the ref via `POST .../git/refs` rather than `PATCH`ing one;
  `handleRepoPush` with exactly one of the two present (not both) still
  400s.
- No automated coverage for `RepoLinkModal.svelte`'s branching on
  `result.kind` — matches this codebase's established precedent (no
  Svelte component tests). Manual verification: create a brand-new repo
  from the app and confirm GitHub shows exactly one commit; unlink and
  re-link a workspace to the same repo and confirm no duplicate files
  appear either locally or on GitHub; link a workspace to a different,
  pre-existing repo with a same-named-but-different-content file and
  confirm the push-conflict modal appears instead of a silent duplicate.
