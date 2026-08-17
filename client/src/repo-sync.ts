// GitHub repo-sync: pure path/content-transform helpers (this task),
// pull/push diff planners, and orchestration (fetch calls to /api/repo/*).
// Kept pure-function-first so the diff/conflict logic is unit-testable
// without mocking fetch — the same reasoning src/github-repo.ts's
// computeNewTreeEntries follows server-side.
import type { Doc, Workspace } from "./types";
import { docsInWorkspace, upsertDocFromRepo, removeDocsByRepoPaths, setDocRepoLinkById, ensureActiveDocInWorkspace, clearRepoSyncMetadata } from "./stores/docs";
import { get } from "svelte/store";
import { nextAvailableName } from "./doc-naming";
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace } from "./stores/workspaces";
import { resolveDiagramRefs } from "./diagram-refs";
import { repoSyncBusyLabel } from "./stores/repoSync";
import { showProgressToast, updateProgressToast, finishProgressToast, showToast } from "./stores/toast";

export function slugifyDocName(name: string): string {
  const slug = (name || "")
    .trim()
    .replace(/[^a-zA-Z0-9 ]+/g, "-")
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
  // A mermaid diagram's fence body is just a short reference key (see
  // diagram-refs.ts) — resolve it back to real source BEFORE the image
  // regex below runs, matching exportAs("md") and getResolvedContent()'s
  // (Gist publish) own established pattern. Diagrams are inlined as text
  // directly in the pushed markdown, not pushed as separate asset files
  // the way images are — GitHub renders ```mermaid fences natively.
  const resolvedContent = resolveDiagramRefs(content, diagrams);
  const assets: ImageAsset[] = [];
  const seenRefs = new Map<string, string>(); // ref -> assigned assets path, so repeats reuse the same path
  const newContent = resolvedContent.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    const dataUrl = images && images[ref];
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
  dirtyDocIds: Set<string>,
  onProgress?: (message: string) => void
): Promise<{ plan: PullPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const treeRes = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/tree?branch=${encodeURIComponent(repoLink.branch)}`);
  if (!treeRes.ok) throw new Error(`Couldn't read the repo tree: HTTP ${treeRes.status}`);
  const treeData = await treeRes.json();
  const entries: TreeEntry[] = treeData.tree || [];
  const docs = docsInWorkspace(workspaceId);
  const plan = planPull(entries, docs, dirtyDocIds);
  const total = plan.creates.length + plan.updates.length;
  let done = 0;

  const docSlugFor = (repoPath: string) => repoPath.replace(/\.md$/i, "").split("/").pop() || "untitled";

  async function fetchAndApply(repoPath: string, sha: string): Promise<void> {
    done++;
    onProgress?.(`Pulling ${done}/${total} file${total === 1 ? "" : "s"}…`);
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

    const resolved = resolveImagesFromPull(rawContent, docSlug, blobs);
    upsertDocFromRepo(workspaceId, repoPath, {
      name: docSlug,
      content: resolved.content,
      images: Object.keys(resolved.images).length ? resolved.images : undefined,
      repoSha: sha,
    });
  }

  for (const create of plan.creates) await fetchAndApply(create.repoPath, create.sha);
  for (const update of plan.updates) await fetchAndApply(update.repoPath, update.sha);
  removeDocsByRepoPaths(workspaceId, plan.deletions.map((d) => d.repoPath));

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    for (const conflict of plan.conflicts) {
      if (resolutions[conflict.docId] === "theirs") await fetchAndApply(conflict.repoPath, conflict.remoteSha);
    }
  }

  return { plan, applyResolved };
}

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

// The images-folder slug is always derived from the doc's FINAL repoPath
// (after dedupeRepoPath), not recomputed from doc.name — pull's own
// docSlugFor() derives its slug the same way, from the path it finds in
// the tree. If this instead used slugifyDocName(doc.name) directly, a
// deduped path (e.g. notes-2.md, when another doc already claimed
// notes.md) would push images under assets/notes/ while pull would later
// look for them under assets/notes-2/ — silently failing to round-trip.
function slugFromRepoPath(repoPath: string): string {
  return repoPath.replace(/\.md$/i, "").split("/").pop() || "untitled";
}

// Git's own blob-object hash: sha1("blob " + byteLength + "\0" + content).
// Used to detect "this doc's pushable content is byte-identical to what's
// already at this path" — doc.repoSha matching the tree's current sha only
// proves the REMOTE hasn't moved since our last sync, not that the LOCAL
// content is actually unchanged since then. Comparing against the real git
// blob sha (rather than just trusting doc.repoSha) is what lets planPush
// skip a doc with no real edits instead of pushing a no-op commit on every
// call.
async function gitBlobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const combined = new Uint8Array(header.length + bytes.length);
  combined.set(header);
  combined.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", combined);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

function dataUrlToBase64(dataUrl: string): string {
  const match = dataUrl.match(/^data:[^;]+;base64,(.*)$/);
  return match ? match[1]! : "";
}

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
    // Fetched fresh here, not reused from `entries` above (which was read
    // for planning and could be stale by the time a push actually goes
    // out) — matches the spec's "fetch the current tree fresh" push step.
    // handleRepoTree's response carries both the tree sha (base_tree for
    // the new tree) and the branch's commit sha (parents[0] for the new
    // commit) — these are two different values and both are needed.
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
    // sameWorkspace is unused here — the empty tree means matchedExistingFile
    // can never become true in this retry, so its value doesn't affect anything.
    const retryPlan = await planPush(winningDocs, [], true);
    await sendChanges(retryPlan.changes);
  }

  return { plan, applyResolved };
}

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

export type CreateFromRepoPlan = { action: "switch"; workspaceId: string } | { action: "create"; workspaceName: string };

// Pure — no store reads, takes the workspace list as a parameter — so
// this is directly unit-testable without touching real store state.
// Two local workspaces both pointed at the same remote repo would fight
// each other on push/pull (each tracking its own, inconsistent repoSha
// per doc), so an exact owner/repo/branch match always wins over
// creating a new one.
export function planCreateWorkspaceFromRepo(owner: string, repo: string, branch: string, workspaces: Workspace[]): CreateFromRepoPlan {
  const existing = workspaces.find((w) => w.repoLink?.owner === owner && w.repoLink?.repo === repo && w.repoLink?.branch === branch);
  if (existing) return { action: "switch", workspaceId: existing.id };
  const taken = new Set(workspaces.map((w) => w.name));
  return { action: "create", workspaceName: nextAvailableName(repo, taken) };
}

export async function createWorkspaceFromRepo(owner: string, repo: string, branch: string): Promise<void> {
  const plan = planCreateWorkspaceFromRepo(owner, repo, branch, get(workspacesStore));
  if (plan.action === "switch") {
    if (switchWorkspace(plan.workspaceId)) ensureActiveDocInWorkspace(plan.workspaceId);
    showToast(`Switched to ${owner}/${repo}`, "success");
    return;
  }
  // createWorkspace() already switches activeWorkspaceIdStore to the new
  // workspace — but the active *document* still points at whatever was
  // open in the previous workspace until ensureActiveDocInWorkspace runs
  // below, once the workspace actually has documents to land on.
  const ws = createWorkspace(plan.workspaceName);
  setWorkspaceRepoLink(ws.id, { owner, repo, branch });
  const progressToastId = showProgressToast("Pulling…");
  try {
    await pullFromRepo(ws.id, { owner, repo, branch }, new Set(), (message) => updateProgressToast(progressToastId, message));
    ensureActiveDocInWorkspace(ws.id);
    finishProgressToast(progressToastId, `Opened ${owner}/${repo}`, "success");
  } catch (err) {
    finishProgressToast(progressToastId, err instanceof Error ? err.message : "Couldn't open that repo", "error");
    throw err;
  }
}

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
