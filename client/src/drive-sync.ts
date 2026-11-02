// Google Drive folder sync: planners first, orchestration below. Mirrors
// repo-sync.ts's shape deliberately (see the design spec's non-goal about a
// generic multi-provider abstraction) — the diff/conflict rules are Drive's
// own because Drive has opaque file ids and revision tokens instead of
// paths and git SHAs.
import { get } from "svelte/store";
import type { Doc, Workspace } from "./types";
import type { ImageAsset } from "./repo-sync";
import {
  assetFolderFor,
  decodeBase64Text,
  dedupeRepoPath,
  mimeFromAssetPath,
  resolveImagesFromPull,
  rewriteImagesForPush,
  slugFromRepoPath,
  slugifyDocName,
} from "./repo-sync";
import {
  docsInWorkspace,
  upsertDocFromDrive,
  removeDocsByDriveFileIds,
  setDocDriveLinkById,
  setDocDriveImageRevs,
  ensureActiveDocInWorkspace,
  clearDriveSyncMetadata,
  findDocById,
  repoDocSyncHook,
  saveActiveDocContent,
  activeIdStore,
  activeDocContent,
} from "./stores/docs";
import {
  workspacesStore,
  createWorkspace,
  switchWorkspace,
  setWorkspaceDriveLink,
  setWorkspaceDriveLastSynced,
  clearPendingDriveDeletions,
  queueDriveDeletion,
} from "./stores/workspaces";
import { nextAvailableName } from "./doc-naming";

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
  // The server stopped at its folder/depth cap. Absence from `entries`
  // then means "not scanned", not "deleted" — never infer deletions or
  // prune assets from a truncated tree.
  truncated?: boolean;
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
  | { kind: "create"; ref: string; path: string; contentBase64: string; hash: string }
  | { kind: "update"; ref: string; path: string; fileId: string; contentBase64: string; hash: string }
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
  // Old file id for each locally-renamed doc. Kept separate from
  // `deletes` so a failed sibling push doesn't delete the only copy when
  // the rename itself never landed.
  renames?: { docId: string; oldFileId: string }[];
  // Deletions the user already committed to locally. They're independent
  // of any create/update, so they can still run when an unrelated file
  // fails in the same push.
  pendingDeletes?: string[];
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

function imageChanged(doc: Doc, treeById: Map<string, DriveEntry>, complete: boolean): boolean {
  for (const stored of Object.values(doc.driveImageRevs ?? {})) {
    const entry = treeById.get(stored.fileId);
    // A missing id on a truncated tree may simply not have been scanned.
    if (!entry) {
      if (complete) return true;
      continue;
    }
    if (entry.rev !== stored.rev) return true;
  }
  return false;
}

export function planDrivePull(tree: DriveTree, docs: Doc[], dirtyDocIds: Set<string>, pendingDriveDeletions: string[] = []): PullPlan {
  const plan: PullPlan = { creates: [], updates: [], conflicts: [], deletions: [], unchanged: [] };
  const pending = new Set(pendingDriveDeletions);
  const mdEntries = tree.entries.filter((entry) => isMarkdownPath(entry.path));
  const treeById = new Map(tree.entries.map((entry) => [entry.fileId, entry]));
  const mdById = new Map(mdEntries.map((entry) => [entry.fileId, entry]));
  const byFileId = new Map(docs.filter((doc) => doc.driveFileId).map((doc) => [doc.driveFileId!, doc]));
  const byPath = new Map(docs.filter((doc) => doc.drivePath).map((doc) => [doc.drivePath!, doc]));
  const matchedDocIds = new Set<string>();

  for (const entry of mdEntries) {
    const doc = byFileId.get(entry.fileId) ?? byPath.get(entry.path);
    if (!doc) {
      // The user deleted this doc locally and the deletion is queued for
      // the next push. Pulling it back as a new doc would silently cancel
      // that intent.
      if (pending.has(entry.fileId)) continue;
      plan.creates.push({ path: entry.path, fileId: entry.fileId, rev: entry.rev });
      continue;
    }
    matchedDocIds.add(doc.id);
    // A rename in Drive can keep the same headRevisionId; the path is
    // still a change worth pulling so the local doc doesn't keep pointing
    // at (and later renaming back to) the old name.
    const pathChanged = !!doc.drivePath && doc.drivePath !== entry.path;
    const changed = pathChanged || doc.driveRev !== entry.rev || imageChanged(doc, treeById, !tree.truncated);
    if (!changed) {
      plan.unchanged.push(doc.id);
    } else if (dirtyDocIds.has(doc.id)) {
      plan.conflicts.push({ docId: doc.id, docName: doc.name, drivePath: entry.path });
    } else {
      plan.updates.push({ docId: doc.id, path: entry.path, fileId: entry.fileId, rev: entry.rev });
    }
  }

  if (!tree.truncated) {
    for (const doc of docs) {
      if (!doc.driveFileId) continue;
      // Only a doc whose file id really vanished is a deletion. A doc
      // matched by path without a file id is a first-pull candidate, not a
      // remote deletion.
      if (mdById.has(doc.driveFileId)) continue;
      if (matchedDocIds.has(doc.id)) continue;
      // Keep a locally edited doc whose remote file disappeared: pushing
      // it recreates the file with the local copy instead of deleting the
      // only remaining version.
      if (dirtyDocIds.has(doc.id)) continue;
      plan.deletions.push({ docId: doc.id, docName: doc.name, drivePath: doc.drivePath ?? doc.name });
    }
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
  const plan: PushPlan = { creates: [], updates: [], deletes: [], conflicts: [], unchanged: [], pendingDeletes: [] };
  const complete = !tree.truncated;
  const mdEntries = tree.entries.filter((entry) => isMarkdownPath(entry.path));
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const byId = new Map(tree.entries.map((entry) => [entry.fileId, entry]));
  const usedPaths = new Set(tree.entries.map((entry) => entry.path));
  const claimedFileIds = new Set<string>();
  const claimedPaths = new Set<string>();
  const seenFileIds = new Set<string>();
  const assetsByFolder = new Map<string, Set<string>>();
  const staleImageIds = new Set<string>();
  const replacedImageIds = new Set<string>();
  const renamedAway = new Set<string>();
  const planned: PlannedChange[] = [];
  const renames: { docId: string; oldFileId: string }[] = [];

  function collectAssets(folder: string): Set<string> {
    let set = assetsByFolder.get(folder);
    if (!set) {
      set = new Set();
      assetsByFolder.set(folder, set);
    }
    return set;
  }

  for (const doc of docs) {
    // Two local docs claiming one Drive file would both PATCH it and
    // overwrite each other. Keep the first owner; flag the rest.
    if (doc.driveFileId && seenFileIds.has(doc.driveFileId)) {
      plan.conflicts.push({ docId: doc.id, docName: doc.name, drivePath: doc.drivePath ?? drivePathForDocName(doc.name) });
      continue;
    }
    if (doc.driveFileId) seenFileIds.add(doc.driveFileId);

    let path = doc.drivePath || "";
    let remote = doc.driveFileId ? byId.get(doc.driveFileId) : undefined;
    let fileId = remote?.fileId;

    if (doc.driveFileId && !remote && !complete) {
      // The tree walk stopped early; this file may simply not have been
      // visited. Leave the doc alone rather than creating a duplicate.
      plan.unchanged.push(doc.id);
      if (doc.drivePath) claimedPaths.add(doc.drivePath);
      claimedFileIds.add(doc.driveFileId);
      continue;
    }

    let renamedOldId: string | undefined;
    let derivedPath = false;
    if (!path) {
      // A never-linked doc must not silently adopt a same-named file in
      // the target folder — it might be another device's document that
      // has not been pulled yet. Dedupe into a fresh path instead.
      path = dedupeRepoPath(drivePathForDocName(doc.name), usedPaths);
      derivedPath = true;
      remote = undefined;
      fileId = undefined;
    } else if (remote && remote.path !== path) {
      // The file was renamed in Drive since our last sync. Keep the
      // current Drive path until the local name actually changes.
      path = remote.path;
    }
    if (!derivedPath && !remote && claimedPaths.has(path)) {
      // Another doc already planned this exact path — don't create a
      // same-named duplicate. A path merely present in the TREE is left
      // alone so the unproven-path conflict below can still fire.
      path = dedupeRepoPath(path, usedPaths);
    }
    usedPaths.add(path);

    // A local rename writes the new path and deletes the old file, same
    // as repo-sync. Compare case-insensitively so a doc named "Notes"
    // mapped to "notes.md" does not churn on every push; only a real
    // slug change counts.
    if (remote && fileId) {
      const currentSlug = slugFromRepoPath(path).toLowerCase();
      const wantedSlug = slugifyDocName(doc.name).toLowerCase();
      if (wantedSlug !== currentSlug && complete) {
        const parent = parentPathOf(path);
        const target = parent ? `${parent}/${slugifyDocName(doc.name)}.md` : `${slugifyDocName(doc.name)}.md`;
        if (!usedPaths.has(target) || target === path) {
          if (target !== path) {
            renamedOldId = fileId;
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
    const replacedThisDoc: string[] = [];
    const referencedRefs = new Set<string>();
    for (const asset of assets) {
      const ref = refForAssetPath(asset.path, folder, doc.images);
      referencedRefs.add(ref);
      const stored = doc.driveImageRevs?.[ref];
      const storedEntry = stored ? byId.get(stored.fileId) : undefined;
      const imageHash = await hashImageDataUrl(asset.dataUrl);
      if (stored && storedEntry && storedEntry.path !== asset.path) {
        // The doc's asset folder moved (a rename). The old image id still
        // exists under the old path; upload a copy under the new path and
        // delete the old one only after the doc write succeeds.
        imageOps.push({ kind: "create", ref, path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl), hash: imageHash });
        if (complete) replacedThisDoc.push(stored.fileId);
        if (storedEntry.rev !== stored.rev) remoteImageChanged = true;
        localImageChanged = true;
      } else if (!stored || !storedEntry) {
        // A stored id missing from a truncated tree may exist; don't
        // upload a duplicate on a guess.
        if (!stored || complete) {
          imageOps.push({ kind: "create", ref, path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl), hash: imageHash });
          localImageChanged = true;
        }
      } else if (storedEntry.rev !== stored.rev) {
        remoteImageChanged = true;
        if (stored.hash !== imageHash) localImageChanged = true;
      } else if (stored.hash !== imageHash) {
        imageOps.push({ kind: "update", ref, path: asset.path, fileId: stored.fileId, contentBase64: dataUrlToBase64(asset.dataUrl), hash: imageHash });
        localImageChanged = true;
      }
    }
    const staleRefs: string[] = [];
    for (const [ref, stored] of Object.entries(doc.driveImageRevs ?? {})) {
      if (referencedRefs.has(ref)) continue;
      if (pendingDriveDeletions.includes(stored.fileId)) continue;
      if (complete && byId.has(stored.fileId) && sameWorkspace) staleRefs.push(stored.fileId);
    }

    const localChanged = doc.drivePushedHash !== contentHash || localImageChanged;
    const revMoved = remote ? (doc.driveRev ? remote.rev !== doc.driveRev : !sameWorkspace) : false;
    const pathMatch = !fileId && byPath.get(path);
    const pathMatchOwner = pathMatch ? docs.find((candidate) => candidate.id !== doc.id && candidate.driveFileId === pathMatch.fileId) : undefined;
    const pathMatchBlocked = !!pathMatch && (claimedFileIds.has(pathMatch.fileId) || !!pathMatchOwner);
    const foreignPathMatch = !!pathMatch && (!sameWorkspace || pathMatchBlocked);

    if ((revMoved && localChanged) || (remoteImageChanged && localChanged) || foreignPathMatch) {
      plan.conflicts.push({ docId: doc.id, docName: doc.name, drivePath: path });
      claimedPaths.add(path);
      if (fileId) claimedFileIds.add(fileId);
      continue;
    }

    // In our own folder, a doc with a path but no stored id can adopt the
    // file already at that path (a pull that never finished, or a doc
    // restored from a backup).
    if (!fileId && sameWorkspace && pathMatch && !pathMatchBlocked) {
      fileId = pathMatch.fileId;
      remote = pathMatch;
    }

    if (renamedOldId) {
      renamedAway.add(renamedOldId);
      renames.push({ docId: doc.id, oldFileId: renamedOldId });
    }
    for (const fileId of replacedThisDoc) replacedImageIds.add(fileId);

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

  // A pending deletion is a known id from the local record, not an
  // inference from the tree — retry it even on a truncated scan. DELETE
  // on an already-gone file is a harmless 404.
  for (const fileId of pendingDriveDeletions) {
    if (claimedFileIds.has(fileId) || plan.deletes.includes(fileId)) continue;
    plan.deletes.push(fileId);
    plan.pendingDeletes!.push(fileId);
  }
  if (complete) {
    for (const fileId of renamedAway) {
      if (byId.has(fileId) && !claimedFileIds.has(fileId) && !plan.deletes.includes(fileId)) plan.deletes.push(fileId);
    }
    for (const fileId of staleImageIds) {
      if (!claimedFileIds.has(fileId) && !plan.deletes.includes(fileId)) plan.deletes.push(fileId);
    }
    for (const fileId of replacedImageIds) {
      if (!claimedFileIds.has(fileId) && !plan.deletes.includes(fileId)) plan.deletes.push(fileId);
    }
  }

  if (sameWorkspace && complete) {
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
    // Dead-folder sweep: assets/<slug>/... whose owning doc is gone from
    // both the tree and this workspace. Only safe on a complete tree and
    // a folder this workspace actually owns.
    for (const entry of tree.entries) {
      const match = /^assets\/(.+)\/[^/]+$/.exec(entry.path);
      if (!match) continue;
      const owner = `${match[1]}.md`;
      if (usedPaths.has(owner) || claimedPaths.has(owner)) continue;
      if (planned.some((change) => change.path === owner)) continue;
      if (claimedFileIds.has(entry.fileId) || plan.deletes.includes(entry.fileId)) continue;
      plan.deletes.push(entry.fileId);
    }
  }

  plan.renames = renames;
  return plan;
}

export { mimeFromAssetPath };

// ---- Orchestration ----
// Every call below goes through our Worker, never straight to Google. The
// Worker owns the OAuth cookie; a 401 means the grant is gone and the UI
// should clear driveConnected and offer a reconnect.

export class DriveReconnectError extends Error {
  constructor() {
    super("Google Drive disconnected — reconnect to sync");
    this.name = "DriveReconnectError";
  }
}

interface PushResultItem {
  path: string;
  op: "create" | "update" | "delete";
  ok: boolean;
  fileId?: string;
  rev?: string;
  error?: string;
}

export interface PushResult {
  results: PushResultItem[];
  synced: number;
  failed: number;
}

async function jsonFetch<T>(url: string, init: RequestInit | undefined, label: string): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) throw new DriveReconnectError();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function workspaceWithLink(workspaceId: string): Workspace {
  const workspace = get(workspacesStore).find((item) => item.id === workspaceId);
  if (!workspace?.driveLink) throw new Error("This workspace isn't linked to Google Drive.");
  return workspace;
}

async function fetchTree(workspaceId: string): Promise<{ workspace: Workspace; tree: DriveTree }> {
  const workspace = workspaceWithLink(workspaceId);
  const tree = await jsonFetch<DriveTree>(
    `/api/drive/folder/${encodeURIComponent(workspace.driveLink!.folderId)}/tree`,
    undefined,
    "Couldn't read the Drive folder",
  );
  return { workspace, tree };
}

async function downloadBase64(fileId: string): Promise<string> {
  const data = await jsonFetch<{ contentBase64: string }>(`/api/drive/file/${encodeURIComponent(fileId)}`, undefined, "Couldn't download from Google Drive");
  return data.contentBase64;
}

function parentPathOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

async function applyRemoteEntry(workspaceId: string, tree: DriveTree, entry: DriveEntry): Promise<{ id: string; created: boolean }> {
  const rawBase64 = await downloadBase64(entry.fileId);
  const rawContent = decodeBase64Text(rawBase64);
  const folder = assetFolderForDrivePath(entry.path);
  const prefix = `assets/${folder}/`;
  const imageRefs = [...rawContent.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map((match) => match[1]!);
  const blobs: Record<string, string> = {};
  const imageRevs: Record<string, { fileId: string; rev: string; hash: string }> = {};
  const existing = docsInWorkspace(workspaceId).find((doc) => doc.driveFileId === entry.fileId || doc.drivePath === entry.path);

  for (const assetPath of imageRefs) {
    const internalRef = assetPath.startsWith(prefix) ? assetPath.slice(prefix.length) : null;
    const assetEntry = tree.entries.find((candidate) => candidate.path === assetPath);
    if (!assetEntry) {
      // A missing asset on a truncated/incomplete tree: if we already
      // have its bytes under the old internal ref, resolve the raw
      // `assets/...` reference back to that copy instead of leaving a
      // broken path in the document.
      if (internalRef && existing?.images?.[internalRef]) blobs[assetPath] = existing.images[internalRef]!;
      continue;
    }
    const base64 = await downloadBase64(assetEntry.fileId);
    const dataUrl = `data:${mimeFromAssetPath(assetPath)};base64,${base64}`;
    blobs[assetPath] = dataUrl;
    if (internalRef) {
      imageRevs[internalRef] = {
        fileId: assetEntry.fileId,
        rev: assetEntry.rev,
        hash: await hashImageDataUrl(dataUrl),
      };
    }
  }

  const resolved = resolveImagesFromPull(rawContent, folder, blobs, slugFromRepoPath(entry.path));
  const resolvedRevs: Record<string, { fileId: string; rev: string; hash?: string }> = { ...(existing?.driveImageRevs ?? {}) };
  for (const ref of Object.keys(resolved.images)) {
    if (imageRevs[ref]) resolvedRevs[ref] = imageRevs[ref]!;
  }
  const rewritten = rewriteImagesForPush(resolved.content, folder, resolved.images, undefined);
  const pushedHash = await hashPushPayload(rewritten.content, rewritten.assets);
  const remoteName = (entry.path.split("/").pop() ?? "untitled").replace(/\.md$/i, "");
  const oldSlug = existing?.drivePath ? slugFromRepoPath(existing.drivePath) : undefined;
  // Adopt a remote rename only when the local name was just the old path
  // basename; a deliberate custom name stays put.
  const name = existing && (!oldSlug || existing.name !== oldSlug) ? existing.name : remoteName;
  // Preserve image bytes we already had. An asset could be missing from
  // this response because of a truncated tree/one failed image download;
  // wiping the map would lose recoverable data for references the new
  // content no longer resolves.
  const mergedImages = { ...(existing?.images ?? {}), ...resolved.images };

  return upsertDocFromDrive(workspaceId, entry.path, {
    name,
    content: resolved.content,
    images: Object.keys(mergedImages).length ? mergedImages : undefined,
    driveFileId: entry.fileId,
    driveRev: entry.rev,
    driveImageRevs: Object.keys(resolvedRevs).length ? resolvedRevs : undefined,
    drivePushedHash: pushedHash,
  });
}

export interface PullFailure {
  docId?: string;
  path: string;
  error: string;
}

async function computeDirtyDocIds(workspaceId: string): Promise<Set<string>> {
  const dirty = new Set<string>();
  for (const doc of docsInWorkspace(workspaceId)) {
    if (!doc.driveFileId && !doc.drivePath) continue;
    if (!doc.drivePushedHash) {
      // A linked doc with no local hash predates the hash field. Treat it
      // as dirty rather than silently overwriting whatever is local.
      dirty.add(doc.id);
      continue;
    }
    const path = doc.drivePath || drivePathForDocName(doc.name);
    const folder = assetFolderForDrivePath(path);
    const { content, assets } = rewriteImagesForPush(doc.content, folder, doc.images, doc.diagrams);
    if ((await hashPushPayload(content, assets)) !== doc.drivePushedHash) dirty.add(doc.id);
  }
  return dirty;
}

export async function pullFromDrive(
  workspaceId: string,
  dirtyDocIds: Set<string> = new Set(),
  onProgress?: (message: string) => void,
): Promise<{
  plan: PullPlan;
  applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
  failures: PullFailure[];
}> {
  // The live editor buffer is the source of truth while a doc is open;
  // flush it before hashing/planning so a just-typed edit counts as dirty
  // instead of being overwritten by a remote update.
  saveActiveDocContent();
  const { workspace, tree } = await fetchTree(workspaceId);
  const docs = docsInWorkspace(workspaceId);
  const dirty = new Set([...dirtyDocIds, ...(await computeDirtyDocIds(workspaceId))]);
  const plan = planDrivePull(tree, docs, dirty, workspace.pendingDriveDeletions ?? []);
  const entriesById = new Map(tree.entries.map((entry) => [entry.fileId, entry]));
  const entriesByPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const total = plan.creates.length + plan.updates.length;
  const failures: PullFailure[] = [];
  let done = 0;
  const created: string[] = [];
  const updated: string[] = [];

  async function applyEntries(items: { fileId: string }[]): Promise<void> {
    for (const item of items) {
      const entry = entriesById.get(item.fileId);
      if (!entry) continue;
      done++;
      onProgress?.(`Pulling ${done}/${total} file${total === 1 ? "" : "s"}…`);
      try {
        // If the user kept typing in the active editor while this pull was
        // in flight, the plan is stale for that doc. Don't overwrite the
        // buffer; leave it for the conflict modal instead.
        const activeId = get(activeIdStore);
        const activeDoc = activeId ? docs.find((doc) => doc.id === activeId) : undefined;
        if (activeDoc && activeDoc.driveFileId === entry.fileId && get(activeDocContent) !== activeDoc.content) {
          plan.conflicts.push({ docId: activeDoc.id, docName: activeDoc.name, drivePath: entry.path });
          continue;
        }
        const result = await applyRemoteEntry(workspaceId, tree, entry);
        (result.created ? created : updated).push(result.id);
      } catch (err) {
        if (err instanceof DriveReconnectError) throw err;
        failures.push({ path: entry.path, error: err instanceof Error ? err.message : "download failed" });
      }
    }
  }

  await applyEntries(plan.creates);
  await applyEntries(plan.updates);

  // Deletions are *not* applied yet: the conflict modal is the user's
  // confirmation, and deleting a doc also deletes its local history.
  // applyResolved runs only when the user clicks Apply.
  const deletedFileIds = plan.deletions
    .map((deletion) => docs.find((doc) => doc.id === deletion.docId)?.driveFileId)
    .filter((fileId): fileId is string => !!fileId);
  setWorkspaceDriveLastSynced(workspaceId, Date.now());
  repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created, updated, deleted: [] });
  const currentActiveId = get(activeIdStore);
  if (currentActiveId && [...created, ...updated].includes(currentActiveId)) window.MDE?.reloadActiveDocFromStore?.();

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const adopted: string[] = [];
    for (const conflict of plan.conflicts) {
      if (resolutions[conflict.docId] !== "theirs") continue;
      const entry = entriesByPath.get(conflict.drivePath);
      if (!entry) continue;
      try {
        const result = await applyRemoteEntry(workspaceId, tree, entry);
        adopted.push(result.id);
      } catch (err) {
        if (err instanceof DriveReconnectError) throw err;
        failures.push({ docId: conflict.docId, path: conflict.drivePath, error: err instanceof Error ? err.message : "download failed" });
      }
    }
    const removed = removeDocsByDriveFileIds(workspaceId, deletedFileIds);
    clearPendingDriveDeletions(workspaceId, deletedFileIds);
    repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created: [], updated: adopted, deleted: removed });
    const currentActiveId = get(activeIdStore);
    if (currentActiveId && [...adopted, ...removed].includes(currentActiveId)) window.MDE?.reloadActiveDocFromStore?.();
    if (failures.length > 0) {
      throw new Error(`${failures.length} file${failures.length === 1 ? "" : "s"} couldn't be pulled — pull again to retry`);
    }
  }

  return { plan, applyResolved, failures };
}

interface PushBody {
  ensureSubfolders: string[];
  creates: { path: string; mimeType: string; contentBase64: string }[];
  updates: { fileId: string; path: string; mimeType: string; contentBase64: string }[];
  deletes: string[];
}

function buildPushBody(plan: PushPlan, includeDeletes = true): PushBody {
  const body: PushBody = { ensureSubfolders: [], creates: [], updates: [], deletes: includeDeletes ? [...plan.deletes] : [] };
  const subfolders = new Set<string>();
  const addSubfolder = (path: string) => {
    const parent = parentPathOf(path);
    if (parent) subfolders.add(parent);
  };

  for (const change of plan.creates) {
    body.creates.push({ path: change.path, mimeType: "text/markdown", contentBase64: change.contentBase64 });
    addSubfolder(change.path);
    for (const op of change.imageOps) {
      if (op.kind === "create") {
        body.creates.push({ path: op.path, mimeType: mimeFromAssetPath(op.path), contentBase64: op.contentBase64 });
        addSubfolder(op.path);
      } else if (op.kind === "update") {
        body.updates.push({ fileId: op.fileId, path: op.path, mimeType: mimeFromAssetPath(op.path), contentBase64: op.contentBase64 });
        addSubfolder(op.path);
      } else if (includeDeletes) {
        body.deletes.push(op.fileId);
      }
    }
  }

  for (const change of plan.updates) {
    body.updates.push({ fileId: change.fileId, path: change.path, mimeType: "text/markdown", contentBase64: change.contentBase64 });
    for (const op of change.imageOps) {
      if (op.kind === "create") {
        body.creates.push({ path: op.path, mimeType: mimeFromAssetPath(op.path), contentBase64: op.contentBase64 });
        addSubfolder(op.path);
      } else if (op.kind === "update") {
        body.updates.push({ fileId: op.fileId, path: op.path, mimeType: mimeFromAssetPath(op.path), contentBase64: op.contentBase64 });
        addSubfolder(op.path);
      } else if (includeDeletes) {
        body.deletes.push(op.fileId);
      }
    }
  }

  body.deletes = [...new Set(body.deletes)];
  body.ensureSubfolders = [...subfolders];
  return body;
}

async function commitPushResults(workspaceId: string, plan: PushPlan, data: PushResult): Promise<void> {
  const createdByPath = new Map<string, PushResultItem>();
  const updatedByFileId = new Map<string, PushResultItem>();
  const deleted = new Set<string>();
  for (const result of data.results) {
    if (!result.ok) continue;
    if (result.op === "create") createdByPath.set(result.path, result);
    else if (result.op === "update") updatedByFileId.set(result.fileId ?? result.path, result);
    else if (result.op === "delete") deleted.add(result.fileId ?? result.path);
  }

  const docs = docsInWorkspace(workspaceId);

  function applyImageOps(change: PushChange, doc: Doc): { imageRevs: Record<string, { fileId: string; rev: string; hash?: string }>; ok: boolean } {
    const imageRevs = { ...(doc.driveImageRevs ?? {}) };
    let ok = true;
    for (const op of change.imageOps) {
      if (op.kind === "create") {
        const result = createdByPath.get(op.path);
        if (!result?.fileId) {
          ok = false;
          continue;
        }
        imageRevs[op.ref] = { fileId: result.fileId, rev: result.rev ?? "", hash: op.hash };
      } else if (op.kind === "update") {
        const result = updatedByFileId.get(op.fileId);
        if (!result) {
          ok = false;
          continue;
        }
        imageRevs[op.ref] = { fileId: op.fileId, rev: result.rev ?? "", hash: op.hash };
      } else if (deleted.has(op.fileId)) {
        delete imageRevs[op.ref];
      } else {
        ok = false;
      }
    }
    return { imageRevs, ok };
  }

  function commitOne(change: PushChange, fileId: string, rev: string): void {
    const doc = docs.find((candidate) => candidate.id === change.docId);
    if (!doc) return;
    const { imageRevs, ok } = applyImageOps(change, doc);
    setDocDriveLinkById(change.docId, {
      drivePath: change.path,
      driveFileId: fileId,
      driveRev: rev,
      driveImageRevs: Object.keys(imageRevs).length ? imageRevs : undefined,
      // A failed image keeps the old hash so the next push re-plans this
      // doc even though its markdown revision was committed.
      drivePushedHash: ok ? change.contentHash : doc.drivePushedHash,
    });
  }

  // The server commits each item independently: a failed markdown update
  // can still leave its images uploaded. Record those successful image
  // revisions anyway, or the next plan sees a fresh remote image rev
  // against our old one and raises a false conflict.
  function commitImagesOnly(change: PushChange): void {
    const doc = docs.find((candidate) => candidate.id === change.docId);
    // A failed markdown update may still have uploaded new/changed images.
    // Its successful DELETE ops are a different story: the remote file
    // still references the old images, so removing them locally would
    // leave a broken remote document. Leave those for the next push.
    const safeOps = change.imageOps.filter((op) => op.kind !== "delete");
    if (!doc || safeOps.length === 0) return;
    const { imageRevs } = applyImageOps({ ...change, imageOps: safeOps }, doc);
    setDocDriveImageRevs(change.docId, Object.keys(imageRevs).length ? imageRevs : undefined);
  }

  for (const change of plan.creates) {
    const result = createdByPath.get(change.path);
    if (result?.fileId) commitOne(change, result.fileId, result.rev ?? "");
    else commitImagesOnly(change);
  }
  for (const change of plan.updates) {
    const result = updatedByFileId.get(change.fileId);
    if (result) commitOne(change, change.fileId, result.rev ?? "");
    else commitImagesOnly(change);
  }

  clearPendingDriveDeletions(workspaceId, [...deleted]);
  setWorkspaceDriveLastSynced(workspaceId, Date.now());
}

async function postPush(workspaceId: string, body: PushBody): Promise<PushResult> {
  const workspace = workspaceWithLink(workspaceId);
  return jsonFetch<PushResult>(
    `/api/drive/folder/${encodeURIComponent(workspace.driveLink!.folderId)}/push`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    "Push to Google Drive failed",
  );
}

function mergePushResults(a: PushResult, b: PushResult): PushResult {
  return { results: [...a.results, ...b.results], synced: a.synced + b.synced, failed: a.failed + b.failed };
}

function commitDeleteResults(workspaceId: string, plan: PushPlan, data: PushResult): void {
  const deleted = new Set<string>();
  for (const result of data.results) {
    if (result.op !== "delete" || !result.fileId) continue;
    if (result.ok) deleted.add(result.fileId);
  }
  clearPendingDriveDeletions(workspaceId, [...deleted]);
  // A rename's old file id only appears in this push plan once. If its
  // delete failed, queue it so the next push still removes it instead of
  // leaving a duplicate behind.
  for (const fileId of plan.deletes) {
    const result = data.results.find((item) => item.op === "delete" && item.fileId === fileId);
    if (result && !result.ok) queueDriveDeletion(workspaceId, fileId);
  }
}

const MAX_PUSH_ITEMS = 40;

// A workspace larger than the Worker's per-request item cap is split by
// document, never mid-document: a doc's image results must travel in the
// same response as the doc so commitPushResults can pair them.
function chunkPushPlan(plan: PushPlan): PushPlan[] {
  const chunks: PushPlan[] = [];
  let current: PushPlan = { creates: [], updates: [], deletes: [], conflicts: [], unchanged: [] };
  let count = 0;
  const flush = () => {
    if (current.creates.length || current.updates.length) chunks.push(current);
    current = { creates: [], updates: [], deletes: [], conflicts: [], unchanged: [] };
    count = 0;
  };
  const add = (kind: "creates" | "updates", change: PushChange) => {
    const cost = 1 + change.imageOps.length;
    if (cost > MAX_PUSH_ITEMS) throw new Error("One document has too many embedded images to push in a single request.");
    if (count + cost > MAX_PUSH_ITEMS) flush();
    current[kind].push(change as never);
    count += cost;
  };
  for (const change of plan.creates) add("creates", change);
  for (const change of plan.updates) add("updates", change);
  flush();
  return chunks;
}

async function sendPlan(workspaceId: string, plan: PushPlan): Promise<PushResult> {
  let combined: PushResult = { results: [], synced: 0, failed: 0 };
  let canDelete = true;
  const completedDocIds = new Set<string>();
  try {
    for (const chunk of chunkPushPlan(plan)) {
      // Creates/updates go first. Deletes wait for their result so a failed
      // rename replacement can never delete the only remote copy first.
      const body = buildPushBody(chunk, false);
      const data = await postPush(workspaceId, body);
      await commitPushResults(workspaceId, chunk, data);
      combined = mergePushResults(combined, data);
      for (const change of [...chunk.creates, ...chunk.updates]) {
        const fileId = "fileId" in change ? change.fileId : undefined;
        const result = data.results.find((item) => item.op !== "delete" && item.ok && (item.path === change.path || (!!fileId && item.fileId === fileId)));
        if (result) completedDocIds.add(change.docId);
      }
      if (data.results.some((result) => result.op !== "delete" && !result.ok)) canDelete = false;
    }
  } catch (err) {
    // A later chunk can fail after an earlier rename landed. Its old file
    // id is no longer in any future plan, so queue it before surfacing
    // the error.
    for (const rename of plan.renames ?? []) {
      if (completedDocIds.has(rename.docId)) queueDriveDeletion(workspaceId, rename.oldFileId);
    }
    throw err;
  }
  if (!canDelete) {
    for (const rename of plan.renames ?? []) {
      if (completedDocIds.has(rename.docId)) queueDriveDeletion(workspaceId, rename.oldFileId);
    }
  }
  const deleteIds = canDelete ? [...new Set(plan.deletes)] : [...new Set(plan.pendingDeletes ?? [])];
  for (let index = 0; index < deleteIds.length; index += MAX_PUSH_ITEMS) {
    const chunk = deleteIds.slice(index, index + MAX_PUSH_ITEMS);
    let data: PushResult;
    try {
      data = await postPush(workspaceId, { ensureSubfolders: [], creates: [], updates: [], deletes: chunk });
    } catch (err) {
      // A network/401 failure can leave the server's delete phase partly
      // done. Queue the whole chunk — retrying a delete that already
      // happened is a harmless 404.
      for (const fileId of chunk) queueDriveDeletion(workspaceId, fileId);
      throw err;
    }
    commitDeleteResults(workspaceId, { ...plan, deletes: chunk }, data);
    combined = mergePushResults(combined, data);
  }
  setWorkspaceDriveLastSynced(workspaceId, Date.now());
  return combined;
}

async function buildForcePushPlan(workspaceId: string, tree: DriveTree, docs: Doc[]): Promise<PushPlan> {
  const byId = new Map(tree.entries.map((entry) => [entry.fileId, entry]));
  const usedPaths = new Set(tree.entries.map((entry) => entry.path));
  const plan: PushPlan = { creates: [], updates: [], deletes: [], conflicts: [], unchanged: [] };

  for (const doc of docs) {
    let path = doc.drivePath || byId.get(doc.driveFileId ?? "")?.path || "";
    if (!path) {
      path = dedupeRepoPath(drivePathForDocName(doc.name), usedPaths);
      usedPaths.add(path);
    }
    const folder = assetFolderForDrivePath(path);
    const { content, assets } = rewriteImagesForPush(doc.content, folder, doc.images, doc.diagrams);
    const imageOps: ImageOp[] = [];
    for (const asset of assets) {
      const ref = refForAssetPath(asset.path, folder, doc.images);
      const stored = doc.driveImageRevs?.[ref];
      const storedEntry = stored ? byId.get(stored.fileId) : undefined;
      const hash = await hashImageDataUrl(asset.dataUrl);
      imageOps.push(
        storedEntry
          ? { kind: "update", ref, path: asset.path, fileId: storedEntry.fileId, contentBase64: dataUrlToBase64(asset.dataUrl), hash }
          : { kind: "create", ref, path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl), hash },
      );
    }
    const change: PushChange = {
      docId: doc.id,
      path,
      contentBase64: toBase64Utf8(content),
      contentHash: await hashPushPayload(content, assets),
      imageOps,
    };
    if (doc.driveFileId && byId.has(doc.driveFileId)) plan.updates.push({ ...change, fileId: doc.driveFileId });
    else plan.creates.push(change);
  }

  return plan;
}

export async function pushToDrive(
  workspaceId: string,
  onProgress?: (message: string) => void,
): Promise<{ plan: PushPlan; result?: PushResult; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  saveActiveDocContent();
  const { workspace, tree } = await fetchTree(workspaceId);
  const docs = docsInWorkspace(workspaceId);
  const sameWorkspace = tree.workspaceId === workspaceId;
  onProgress?.("Comparing the folder…");
  const plan = await planDrivePush(docs, tree, sameWorkspace, workspace.pendingDriveDeletions ?? []);

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const adopted: string[] = [];
    for (const conflict of plan.conflicts) {
      if (resolutions[conflict.docId] !== "theirs") continue;
      const entry = tree.entries.find((candidate) => candidate.path === conflict.drivePath);
      if (!entry) continue;
      const result = await applyRemoteEntry(workspaceId, tree, entry);
      adopted.push(result.id);
    }
    const winning = plan.conflicts
      .filter((conflict) => resolutions[conflict.docId] === "mine")
      .map((conflict) => docs.find((doc) => doc.id === conflict.docId))
      .filter((doc): doc is Doc => !!doc);
    let failed = 0;
    if (winning.length) {
      const forcePlan = await buildForcePushPlan(workspaceId, tree, winning);
      failed += (await sendPlan(workspaceId, forcePlan)).failed;
    }
    // A push conflict pauses the WHOLE plan. Now that the conflicted docs
    // are resolved, send everything else that was waiting (new docs,
    // non-conflicting updates, pending deletions) instead of leaving it
    // unsent until the user happens to push again.
    const residual: PushPlan = {
      creates: plan.creates,
      updates: plan.updates,
      deletes: plan.deletes,
      conflicts: [],
      unchanged: [],
      renames: plan.renames,
      pendingDeletes: plan.pendingDeletes,
    };
    if (residual.creates.length || residual.updates.length || residual.deletes.length) {
      failed += (await sendPlan(workspaceId, residual)).failed;
    }
    if (adopted.length) repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created: [], updated: adopted, deleted: [] });
    const currentActiveId = get(activeIdStore);
    if (currentActiveId && adopted.includes(currentActiveId)) window.MDE?.reloadActiveDocFromStore?.();
    setWorkspaceDriveLastSynced(workspaceId, Date.now());
    if (failed > 0) throw new Error(`${failed} file${failed === 1 ? "" : "s"} failed to push — push again to retry`);
  }

  if (plan.conflicts.length > 0) return { plan, applyResolved };

  const result = await sendPlan(workspaceId, plan);
  return { plan, result, applyResolved };
}

export async function linkWorkspaceToDrive(
  workspaceId: string,
  folderName: string,
  onProgress?: (message: string) => void,
): Promise<{ plan: PushPlan; result?: PushResult; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const workspace = get(workspacesStore).find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("Workspace not found.");
  onProgress?.("Creating the Drive folder…");
  const folder = await jsonFetch<{ folderId: string; folderName: string }>(
    "/api/drive/folder",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, workspaceName: workspace.name, folderName }),
    },
    "Couldn't create the Drive folder",
  );
  setWorkspaceDriveLink(workspaceId, { folderId: folder.folderId, folderName: folder.folderName });
  clearDriveSyncMetadata(workspaceId);
  return pushToDrive(workspaceId, onProgress);
}

export type CreateWorkspaceFromDrivePlan = { action: "switch"; workspaceId: string } | { action: "create"; workspaceName: string };

export function planCreateWorkspaceFromDrive(folder: { folderId: string; folderName: string }, workspaces: Workspace[]): CreateWorkspaceFromDrivePlan {
  const existing = workspaces.find((workspace) => workspace.driveLink?.folderId === folder.folderId);
  if (existing) return { action: "switch", workspaceId: existing.id };
  const taken = new Set(workspaces.map((workspace) => workspace.name));
  return { action: "create", workspaceName: nextAvailableName(folder.folderName, taken) };
}

export interface OpenDriveFolderResult {
  kind: "opened";
  workspace: Workspace;
  switched: boolean;
  plan: PullPlan;
  applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
  failures: PullFailure[];
}

export async function openDriveFolderAsWorkspace(
  folder: { folderId: string; folderName: string },
  onProgress?: (message: string) => void,
): Promise<OpenDriveFolderResult> {
  const plan = planCreateWorkspaceFromDrive(folder, get(workspacesStore));
  if (plan.action === "switch") {
    const workspace = get(workspacesStore).find((item) => item.id === plan.workspaceId)!;
    switchWorkspace(workspace.id);
    // Re-opening a folder must also retry a pull that previously failed
    // partway instead of silently landing on an empty/partial workspace.
    const pull = await pullFromDrive(workspace.id, new Set(), onProgress);
    ensureActiveDocInWorkspace(workspace.id);
    return { kind: "opened", workspace, switched: true, plan: pull.plan, applyResolved: pull.applyResolved, failures: pull.failures };
  }
  const workspace = createWorkspace(plan.workspaceName);
  setWorkspaceDriveLink(workspace.id, { folderId: folder.folderId, folderName: folder.folderName });
  const pull = await pullFromDrive(workspace.id, new Set(), onProgress);
  ensureActiveDocInWorkspace(workspace.id);
  return { kind: "opened", workspace, switched: false, plan: pull.plan, applyResolved: pull.applyResolved, failures: pull.failures };
}
