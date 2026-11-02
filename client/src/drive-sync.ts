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
} from "./stores/docs";
import {
  workspacesStore,
  createWorkspace,
  switchWorkspace,
  setWorkspaceDriveLink,
  setWorkspaceDriveLastSynced,
  clearPendingDriveDeletions,
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
        imageOps.push({ kind: "create", ref, path: asset.path, contentBase64: dataUrlToBase64(asset.dataUrl), hash: imageHash });
        localImageChanged = true;
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

  for (const assetPath of imageRefs) {
    const assetEntry = tree.entries.find((candidate) => candidate.path === assetPath);
    if (!assetEntry) continue;
    const base64 = await downloadBase64(assetEntry.fileId);
    const dataUrl = `data:${mimeFromAssetPath(assetPath)};base64,${base64}`;
    blobs[assetPath] = dataUrl;
    if (assetPath.startsWith(prefix)) {
      imageRevs[assetPath.slice(prefix.length)] = {
        fileId: assetEntry.fileId,
        rev: assetEntry.rev,
        hash: await hashImageDataUrl(dataUrl),
      };
    }
  }

  const resolved = resolveImagesFromPull(rawContent, folder, blobs, slugFromRepoPath(entry.path));
  const resolvedRevs: Record<string, { fileId: string; rev: string; hash: string }> = {};
  for (const ref of Object.keys(resolved.images)) {
    if (imageRevs[ref]) resolvedRevs[ref] = imageRevs[ref]!;
  }
  const rewritten = rewriteImagesForPush(resolved.content, folder, resolved.images, undefined);
  const pushedHash = await hashPushPayload(rewritten.content, rewritten.assets);
  const existing = docsInWorkspace(workspaceId).find((doc) => doc.driveFileId === entry.fileId || doc.drivePath === entry.path);
  const name = existing?.name ?? (entry.path.split("/").pop() ?? "untitled").replace(/\.md$/i, "");

  return upsertDocFromDrive(workspaceId, entry.path, {
    name,
    content: resolved.content,
    images: Object.keys(resolved.images).length ? resolved.images : undefined,
    driveFileId: entry.fileId,
    driveRev: entry.rev,
    driveImageRevs: Object.keys(resolvedRevs).length ? resolvedRevs : undefined,
    drivePushedHash: pushedHash,
  });
}

export async function pullFromDrive(
  workspaceId: string,
  dirtyDocIds: Set<string> = new Set(),
  onProgress?: (message: string) => void,
): Promise<{ plan: PullPlan; applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void> }> {
  const { tree } = await fetchTree(workspaceId);
  const docs = docsInWorkspace(workspaceId);
  const plan = planDrivePull(tree, docs, dirtyDocIds);
  const entriesById = new Map(tree.entries.map((entry) => [entry.fileId, entry]));
  const entriesByPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const total = plan.creates.length + plan.updates.length;
  let done = 0;
  const created: string[] = [];
  const updated: string[] = [];

  async function applyEntries(items: { fileId: string }[]): Promise<void> {
    for (const item of items) {
      const entry = entriesById.get(item.fileId);
      if (!entry) continue;
      done++;
      onProgress?.(`Pulling ${done}/${total} file${total === 1 ? "" : "s"}…`);
      const result = await applyRemoteEntry(workspaceId, tree, entry);
      (result.created ? created : updated).push(result.id);
    }
  }

  await applyEntries(plan.creates);
  await applyEntries(plan.updates);

  const deletedFileIds = plan.deletions
    .map((deletion) => docs.find((doc) => doc.id === deletion.docId)?.driveFileId)
    .filter((fileId): fileId is string => !!fileId);
  const removed = removeDocsByDriveFileIds(workspaceId, deletedFileIds);
  // removeDocById queues every local delete for the next push; a deletion
  // that came FROM Drive must not be echoed back as one.
  clearPendingDriveDeletions(workspaceId, deletedFileIds);
  setWorkspaceDriveLastSynced(workspaceId, Date.now());
  repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created, updated, deleted: removed });

  async function applyResolved(resolutions: Record<string, "mine" | "theirs">): Promise<void> {
    const adopted: string[] = [];
    for (const conflict of plan.conflicts) {
      if (resolutions[conflict.docId] !== "theirs") continue;
      const entry = entriesByPath.get(conflict.drivePath);
      if (!entry) continue;
      const result = await applyRemoteEntry(workspaceId, tree, entry);
      adopted.push(result.id);
    }
    if (adopted.length) repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created: [], updated: adopted, deleted: [] });
  }

  return { plan, applyResolved };
}

interface PushBody {
  ensureSubfolders: string[];
  creates: { path: string; mimeType: string; contentBase64: string }[];
  updates: { fileId: string; path: string; mimeType: string; contentBase64: string }[];
  deletes: string[];
}

function buildPushBody(plan: PushPlan): PushBody {
  const body: PushBody = { ensureSubfolders: [], creates: [], updates: [], deletes: [...plan.deletes] };
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
      } else {
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
      } else {
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
    if (!doc || change.imageOps.length === 0) return;
    const { imageRevs } = applyImageOps(change, doc);
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

async function sendPlan(workspaceId: string, plan: PushPlan): Promise<PushResult> {
  const workspace = workspaceWithLink(workspaceId);
  const body = buildPushBody(plan);
  if (body.creates.length === 0 && body.updates.length === 0 && body.deletes.length === 0) {
    setWorkspaceDriveLastSynced(workspaceId, Date.now());
    return { results: [], synced: 0, failed: 0 };
  }
  const data = await jsonFetch<PushResult>(
    `/api/drive/folder/${encodeURIComponent(workspace.driveLink!.folderId)}/push`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    "Push to Google Drive failed",
  );
  await commitPushResults(workspaceId, plan, data);
  return data;
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
    if (winning.length) {
      const forcePlan = await buildForcePushPlan(workspaceId, tree, winning);
      await sendPlan(workspaceId, forcePlan);
    }
    if (adopted.length) repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created: [], updated: adopted, deleted: [] });
    setWorkspaceDriveLastSynced(workspaceId, Date.now());
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

export type OpenDriveFolderResult =
  | { kind: "switch"; workspaceId: string }
  | {
      kind: "opened";
      workspace: Workspace;
      plan: PullPlan;
      applyResolved: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
    };

export async function openDriveFolderAsWorkspace(
  folder: { folderId: string; folderName: string },
  onProgress?: (message: string) => void,
): Promise<OpenDriveFolderResult> {
  const plan = planCreateWorkspaceFromDrive(folder, get(workspacesStore));
  if (plan.action === "switch") {
    if (switchWorkspace(plan.workspaceId)) ensureActiveDocInWorkspace(plan.workspaceId);
    return { kind: "switch", workspaceId: plan.workspaceId };
  }
  const workspace = createWorkspace(plan.workspaceName);
  setWorkspaceDriveLink(workspace.id, { folderId: folder.folderId, folderName: folder.folderName });
  const pull = await pullFromDrive(workspace.id, new Set(), onProgress);
  ensureActiveDocInWorkspace(workspace.id);
  return { kind: "opened", workspace, plan: pull.plan, applyResolved: pull.applyResolved };
}
