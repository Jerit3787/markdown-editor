// GitHub repo-sync: pure path/content-transform helpers (this task),
// pull/push diff planners, and orchestration (fetch calls to /api/repo/*).
// Kept pure-function-first so the diff/conflict logic is unit-testable
// without mocking fetch — the same reasoning src/github-repo.ts's
// computeNewTreeEntries follows server-side.
import type { Doc } from "./types";
import { docsInWorkspace, upsertDocFromRepo, removeDocsByRepoPaths } from "./stores/docs";

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
