// Google Drive folder sync: planners first, orchestration below. Mirrors
// repo-sync.ts's shape deliberately (see the design spec's non-goal about a
// generic multi-provider abstraction) — the diff/conflict rules are Drive's
// own because Drive has opaque file ids and revision tokens instead of
// paths and git SHAs.
import type { Doc } from "./types";
import type { ImageAsset } from "./repo-sync";
import { assetFolderFor, dedupeRepoPath, mimeFromAssetPath, rewriteImagesForPush, slugFromRepoPath, slugifyDocName } from "./repo-sync";

export interface DriveEntry {
  fileId: string;
  path: string;
  mimeType: string;
  rev: string;
}

export interface DriveTree {
  folderId: string;
  folderName: string;
  workspaceId: string | null;
  entries: DriveEntry[];
}

export interface DriveConflict {
  docId: string;
  docName: string;
  drivePath: string;
}

export interface PullPlan {
  creates: { path: string; fileId: string; rev: string }[];
  updates: { docId: string; path: string; fileId: string; rev: string }[];
  conflicts: DriveConflict[];
  deletions: { docId: string; docName: string; drivePath: string }[];
  unchanged: string[];
}

export type ImageOp =
  | { kind: "create"; ref: string; path: string; contentBase64: string }
  | { kind: "update"; ref: string; fileId: string; contentBase64: string }
  | { kind: "delete"; ref: string; fileId: string };

export interface PushChange {
  docId: string;
  path: string;
  contentBase64: string;
  contentHash: string;
  imageOps: ImageOp[];
}

export interface PushPlan {
  creates: PushChange[];
  updates: (PushChange & { fileId: string })[];
  deletes: string[];
  conflicts: DriveConflict[];
  unchanged: string[];
}

export function assetFolderForDrivePath(drivePath: string): string {
  return assetFolderFor(drivePath);
}

export function drivePathForDocName(name: string): string {
  return `${slugifyDocName(name)}.md`;
}

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

// Drive revs change when *anything* about the file changes. For the
// conflict key that is exactly what we want, but it cannot answer "did the
// local payload change since our last push" — this hash is the local half
// of that comparison. Assets are sorted so two calls over the same files
// always agree regardless of object key order.
async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashPushPayload(content: string, assets: ImageAsset[]): Promise<string> {
  const canonical = JSON.stringify({
    content,
    assets: [...assets].sort((a, b) => a.path.localeCompare(b.path)).map((asset) => ({ path: asset.path, dataUrl: asset.dataUrl })),
  });
  return sha256Hex(canonical);
}

export async function hashImageDataUrl(dataUrl: string): Promise<string> {
  return sha256Hex(dataUrl);
}

function dataUrlToBase64(dataUrl: string): string {
  const match = /^data:[^;]+;base64,(.*)$/.exec(dataUrl);
  return match ? match[1]! : "";
}

export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

// rewriteImagesForPush returns assets by path, not by the document's
// internal ref key. The ref is recoverable: it generated the asset name in
// the first place (`ref` or `ref.<ext>` under assets/<folder>/).
function refForAssetPath(assetPath: string, folder: string, images: Record<string, string> | undefined): string {
  const prefix = `assets/${folder}/`;
  const tail = assetPath.startsWith(prefix) ? assetPath.slice(prefix.length) : assetPath.split("/").pop() || assetPath;
  const keys = Object.keys(images ?? {});
  if (keys.includes(tail)) return tail;
  const dot = tail.lastIndexOf(".");
  if (dot > 0) {
    const stem = tail.slice(0, dot);
    if (keys.includes(stem)) return stem;
  }
  return tail;
}

function imageChanged(doc: Doc, treeById: Map<string, DriveEntry>): boolean {
  for (const stored of Object.values(doc.driveImageRevs ?? {})) {
    const entry = treeById.get(stored.fileId);
    if (!entry || entry.rev !== stored.rev) return true;
  }
  return false;
}

export function planDrivePull(tree: DriveTree, docs: Doc[], dirtyDocIds: Set<string>): PullPlan {
  const plan: PullPlan = { creates: [], updates: [], conflicts: [], deletions: [], unchanged: [] };
  const mdEntries = tree.entries.filter((entry) => isMarkdownPath(entry.path));
  const treeById = new Map(tree.entries.map((entry) => [entry.fileId, entry]));
  const mdById = new Map(mdEntries.map((entry) => [entry.fileId, entry]));
  const byFileId = new Map(docs.filter((doc) => doc.driveFileId).map((doc) => [doc.driveFileId!, doc]));
  const byPath = new Map(docs.filter((doc) => doc.drivePath).map((doc) => [doc.drivePath!, doc]));
  const matchedDocIds = new Set<string>();

  for (const entry of mdEntries) {
    const doc = byFileId.get(entry.fileId) ?? byPath.get(entry.path);
    if (!doc) {
      plan.creates.push({ path: entry.path, fileId: entry.fileId, rev: entry.rev });
      continue;
    }
    matchedDocIds.add(doc.id);
    const changed = doc.driveRev !== entry.rev || imageChanged(doc, treeById);
    if (!changed) {
      plan.unchanged.push(doc.id);
    } else if (dirtyDocIds.has(doc.id)) {
      plan.conflicts.push({ docId: doc.id, docName: doc.name, drivePath: entry.path });
    } else {
      plan.updates.push({ docId: doc.id, path: entry.path, fileId: entry.fileId, rev: entry.rev });
    }
  }

  for (const doc of docs) {
    if (!doc.driveFileId) continue;
    // Only a doc whose file id really vanished is a deletion. A doc
    // matched by path without a file id is a first-pull candidate, not a
    // remote deletion.
    if (mdById.has(doc.driveFileId)) continue;
    if (matchedDocIds.has(doc.id)) continue;
    plan.deletions.push({ docId: doc.id, docName: doc.name, drivePath: doc.drivePath ?? doc.name });
  }

  return plan;
}

interface PlannedChange {
  docId: string;
  path: string;
  contentBase64: string;
  contentHash: string;
  fileId?: string;
  imageOps: ImageOp[];
  localChanged: boolean;
}

export async function planDrivePush(docs: Doc[], tree: DriveTree, sameWorkspace: boolean, pendingDriveDeletions: string[] = []): Promise<PushPlan> {
  const plan: PushPlan = { creates: [], updates: [], deletes: [], conflicts: [], unchanged: [] };
  const mdEntries = tree.entries.filter((entry) => isMarkdownPath(entry.path));
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const byId = new Map(tree.entries.map((entry) => [entry.fileId, entry]));
  const usedPaths = new Set(tree.entries.map((entry) => entry.path));
  const claimedFileIds = new Set<string>();
  const claimedPaths = new Set<string>();
  const assetsByFolder = new Map<string, Set<string>>();
  const staleImageIds = new Set<string>();
  const renamedAway = new Set<string>();
  const planned: PlannedChange[] = [];

  function collectAssets(folder: string): Set<string> {
    let set = assetsByFolder.get(folder);
    if (!set) {
      set = new Set();
      assetsByFolder.set(folder, set);
    }
    return set;
  }

  for (const doc of docs) {
    let path = doc.drivePath || "";
    let remote = doc.driveFileId ? byId.get(doc.driveFileId) : undefined;
    let fileId = remote?.fileId;

    if (!path) {
      // A never-linked doc must not silently adopt a same-named file in
      // the target folder — it might be another device's document that
      // has not been pulled yet. Dedupe into a fresh path instead.
      path = dedupeRepoPath(drivePathForDocName(doc.name), usedPaths);
      usedPaths.add(path);
      remote = undefined;
      fileId = undefined;
    } else if (remote && remote.path !== path) {
      // The file was renamed in Drive since our last sync. Keep the
      // current Drive path until the local name actually changes.
      path = remote.path;
      usedPaths.add(path);
    }

    // A local rename writes the new path and deletes the old file, same
    // as repo-sync. Compare case-insensitively so a doc named "Notes"
    // mapped to "notes.md" does not churn on every push; only a real
    // slug change counts.
    if (remote && fileId) {
      const currentSlug = slugFromRepoPath(path).toLowerCase();
      const wantedSlug = slugifyDocName(doc.name).toLowerCase();
      if (wantedSlug !== currentSlug) {
        const target = `${slugifyDocName(doc.name)}.md`;
        if (!usedPaths.has(target) || target === path) {
          if (target !== path) {
            renamedAway.add(fileId);
            path = dedupeRepoPath(target, usedPaths);
            usedPaths.add(path);
            remote = undefined;
            fileId = undefined;
          }
        }
      }
    }

    // A stored file id that no longer exists in the tree was deleted in
    // Drive. Recreate it at the same path rather than failing every push.
    if (doc.driveFileId && !fileId && !remote) {
      fileId = undefined;
      remote = undefined;
    }

    const folder = assetFolderForDrivePath(path);
    const { content, assets } = rewriteImagesForPush(doc.content, folder, doc.images, doc.diagrams);
    const contentHash = await hashPushPayload(content, assets);

    const imageOps: ImageOp[] = [];
    let localImageChanged = false;
    let remoteImageChanged = false;
    const referencedRefs = new Set<string>();
    for (const asset of assets) {
      const ref = refForAssetPath(asset.path, folder, doc.images);
      referencedRefs.add(ref);
      const stored = doc.driveImageRevs?.[ref];
      const storedEntry = stored ? byId.get(stored.fileId) : undefined;
      const imageHash = await hashImageDataUrl(asset.dataUrl);
      if (!stored || !storedEntry) {
        imageOps.push({ kind: "create", ref, path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl) });
        localImageChanged = true;
      } else if (storedEntry.rev !== stored.rev) {
        remoteImageChanged = true;
        if (stored.hash !== imageHash) localImageChanged = true;
      } else if (stored.hash !== imageHash) {
        imageOps.push({ kind: "update", ref, fileId: stored.fileId, contentBase64: dataUrlToBase64(asset.dataUrl) });
        localImageChanged = true;
      }
    }
    const staleRefs: string[] = [];
    for (const [ref, stored] of Object.entries(doc.driveImageRevs ?? {})) {
      if (referencedRefs.has(ref)) continue;
      if (pendingDriveDeletions.includes(stored.fileId)) continue;
      if (byId.has(stored.fileId) && sameWorkspace) staleRefs.push(stored.fileId);
    }

    const localChanged = doc.drivePushedHash !== contentHash || localImageChanged;
    const revMoved = remote ? (doc.driveRev ? remote.rev !== doc.driveRev : !sameWorkspace) : false;
    const pathMatch = !fileId && byPath.get(path);
    const foreignPathMatch = !!pathMatch && !sameWorkspace;

    if ((revMoved && localChanged) || (remoteImageChanged && localChanged) || foreignPathMatch) {
      plan.conflicts.push({ docId: doc.id, docName: doc.name, drivePath: path });
      claimedPaths.add(path);
      if (fileId) claimedFileIds.add(fileId);
      continue;
    }

    // In our own folder, a doc with a path but no stored id can adopt the
    // file already at that path (a pull that never finished, or a doc
    // restored from a backup).
    if (!fileId && sameWorkspace && pathMatch) {
      fileId = pathMatch.fileId;
      remote = pathMatch;
    }

    collectAssets(folder);
    const referenced = assetsByFolder.get(folder)!;
    for (const asset of assets) referenced.add(asset.path);
    for (const staleFileId of staleRefs) staleImageIds.add(staleFileId);

    planned.push({
      docId: doc.id,
      path,
      contentBase64: toBase64Utf8(content),
      contentHash,
      fileId,
      imageOps,
      localChanged,
    });
    claimedPaths.add(path);
    if (fileId) claimedFileIds.add(fileId);
  }

  for (const change of planned) {
    const { localChanged, fileId, ...rest } = change;
    const existing = fileId ? byId.get(fileId) : undefined;
    if (existing && fileId) {
      if (!localChanged) {
        plan.unchanged.push(change.docId);
        continue;
      }
      plan.updates.push({ ...rest, fileId });
    } else {
      plan.creates.push(rest);
    }
  }

  for (const fileId of renamedAway) {
    if (byId.has(fileId) && !claimedFileIds.has(fileId) && !plan.deletes.includes(fileId)) plan.deletes.push(fileId);
  }
  for (const fileId of pendingDriveDeletions) {
    if (byId.has(fileId) && !claimedFileIds.has(fileId) && !plan.deletes.includes(fileId)) plan.deletes.push(fileId);
  }
  for (const fileId of staleImageIds) {
    if (!claimedFileIds.has(fileId) && !plan.deletes.includes(fileId)) plan.deletes.push(fileId);
  }

  if (sameWorkspace) {
    for (const [folder, referenced] of assetsByFolder) {
      const prefix = `assets/${folder}/`;
      for (const entry of tree.entries) {
        if (!entry.path.startsWith(prefix)) continue;
        if (referenced.has(entry.path)) continue;
        if (claimedFileIds.has(entry.fileId)) continue;
        if (plan.deletes.includes(entry.fileId)) continue;
        plan.deletes.push(entry.fileId);
      }
    }
  }

  return plan;
}

export { mimeFromAssetPath };
