// Local (never-shared) documents' version history — a new IndexedDB
// database, since localStorage (used for the docs array itself) is both
// synchronous and shares one small quota across every doc, image, and
// diagram already. Shared documents' history instead lives server-side in
// CollabRoom's own Durable Object storage (see src/collab-room.ts) and is
// fetched via the functions in the second half of this file — once a
// document is shared, the Durable Object is the sole owner of its
// history; app.ts only calls the functions in this first half for
// documents that have never been shared.

const DB_NAME = "mde-history";
const DB_VERSION = 1;
const STORE_NAME = "docHistory";
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 50;

export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
}

export interface VersionSummary {
  id: string;
  timestamp: number;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "docId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getHistory(docId: string): Promise<Snapshot[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(docId);
    req.onsuccess = () => resolve(req.result ? req.result.snapshots : []);
    req.onerror = () => reject(req.error);
  });
}

async function putHistory(docId: string, snapshots: Snapshot[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ docId, snapshots });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function appendSnapshot(docId: string, content: string, now: number): Promise<void> {
  const snapshots = await getHistory(docId);
  snapshots.push({ id: uid(), timestamp: now, content });
  while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  await putHistory(docId, snapshots);
}

// Called from app.ts's saveNow(), for documents that have never been
// shared. Wrapped in try/catch: IndexedDB being unavailable or over quota
// must never block the actual (localStorage) document save — history is
// a best-effort background record, not the document's source of truth.
export async function maybeSnapshotVersion(docId: string, content: string, now: number = Date.now()): Promise<void> {
  try {
    const snapshots = await getHistory(docId);
    const last = snapshots[snapshots.length - 1];
    if (last) {
      if (now - last.timestamp < SNAPSHOT_INTERVAL_MS) return;
      if (last.content === content) return;
    }
    await appendSnapshot(docId, content, now);
  } catch (err) {
    // best-effort — see comment above
  }
}

export async function listVersions(docId: string): Promise<VersionSummary[]> {
  const snapshots = await getHistory(docId);
  return snapshots.map((s) => ({ id: s.id, timestamp: s.timestamp })).reverse();
}

export async function getVersionContent(docId: string, versionId: string): Promise<string | undefined> {
  const snapshots = await getHistory(docId);
  return snapshots.find((s) => s.id === versionId)?.content;
}

// Non-destructive: force-appends a new snapshot for the restored content
// (bypassing the throttle) rather than deleting anything newer — the
// restore itself becomes undoable by restoring whatever was current
// before it.
export async function restoreLocalVersion(docId: string, versionId: string, now: number = Date.now()): Promise<string | undefined> {
  const content = await getVersionContent(docId, versionId);
  if (content === undefined) return undefined;
  await appendSnapshot(docId, content, now);
  return content;
}

export async function deleteHistory(docId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(docId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Shared (collaboration-room) documents ----------
// Thin fetch wrappers over CollabRoom's HTTP routes — same same-origin
// relative-fetch, try/catch-with-safe-fallback style as collab.ts's own
// fetchAccess/putAccess.

export async function listSharedVersions(workspaceId: string, docId: string): Promise<VersionSummary[]> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions`);
    if (!res.ok) return [];
    return (await res.json()) as VersionSummary[];
  } catch (err) {
    return [];
  }
}

export async function getSharedVersionContent(workspaceId: string, docId: string, versionId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}`);
    if (!res.ok) return undefined;
    const snap = (await res.json()) as Snapshot;
    return snap.content;
  } catch (err) {
    return undefined;
  }
}

// The restored content isn't returned here — it propagates to every
// connected client (including this one) through the normal Yjs sync
// channel once the server applies it, same as any other collaborator's
// edit. The caller only needs to know whether the request succeeded.
export async function restoreSharedVersion(workspaceId: string, docId: string, versionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
    return res.ok;
  } catch (err) {
    return false;
  }
}
