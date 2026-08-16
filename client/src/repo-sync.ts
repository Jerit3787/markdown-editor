// GitHub repo-sync: pure path/content-transform helpers (this task),
// pull/push diff planners, and orchestration (fetch calls to /api/repo/*).
// Kept pure-function-first so the diff/conflict logic is unit-testable
// without mocking fetch — the same reasoning src/github-repo.ts's
// computeNewTreeEntries follows server-side.
import type { Doc } from "./types";
import { docsInWorkspace, upsertDocFromRepo, removeDocsByRepoPaths, setDocRepoLinkById } from "./stores/docs";

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

  async function fetchAndApply(repoPath: string, sha: string): Promise<void> {
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
  const plan = await planPush(docs, entries);

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
    const retryPlan = await planPush(winningDocs, []);
    await sendChanges(retryPlan.changes);
  }

  return { plan, applyResolved };
}
