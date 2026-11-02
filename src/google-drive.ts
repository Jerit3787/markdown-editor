import { getGoogleAccessToken } from "./google-auth.js";
import type { Env } from "./env";

// Drive API v3 proxy behind the mde_google_session cookie. This plan:
// picker-token + import. Later plans add folder / tree / push / export /
// revisions.

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
// Same cap as the import path — text-only, but keeps a hostile/accidental
// huge payload from exhausting the Worker's memory.
const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sanitizeExportName(raw: unknown): string {
  const name =
    typeof raw === "string"
      ? raw
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 200)
      : "";
  return name || "document.md";
}

// Attaches `setCookie` (from a transparent token refresh in
// getGoogleAccessToken) to a Response so the browser keeps the
// re-encrypted session.
function withCookie(res: Response, setCookie?: string): Response {
  if (!setCookie) return res;
  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", setCookie);
  return new Response(res.body, { status: res.status, headers });
}

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

// The Google Picker is a Google-hosted iframe with no server-side
// equivalent — it needs an OAuth token *in the browser*. This is the only
// place the Drive access token leaves the Worker. Bounded: the scope is
// drive.file (the token can only touch app-created / already-picked
// files), it's fetched only at the moment the Picker opens, and the
// actual downloads go back through /api/drive/import so the token isn't
// needed once the Picker closes.
export async function handleDrivePickerToken(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_API_KEY) return new Response("Google Drive is not configured.", { status: 503 });
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  // The Picker MUST be given the Cloud project number via setAppId for
  // `drive.file`-scoped picks to actually grant the app access to the
  // chosen files — without it every later files.get returns 404. The
  // project number is the numeric prefix of the OAuth client id.
  const appId = (env.GOOGLE_CLIENT_ID ?? "").split("-")[0] ?? "";
  return withCookie(Response.json({ token: auth.token, apiKey: env.GOOGLE_API_KEY, appId }), auth.setCookie);
}

export async function handleDriveExport(request: Request, env: Env): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });

  let body: { fileId?: unknown; name?: unknown; parentFolderId?: unknown; contentBase64?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  if (typeof body.contentBase64 !== "string" || !body.contentBase64) {
    return new Response("contentBase64 is required.", { status: 400 });
  }
  const bytes = fromBase64(body.contentBase64);
  if (bytes.byteLength > MAX_EXPORT_BYTES) {
    return new Response("Document is too large to save to Google Drive.", { status: 413 });
  }

  const name = sanitizeExportName(body.name);
  const fileId = typeof body.fileId === "string" && body.fileId ? body.fileId : undefined;
  const parentFolderId = typeof body.parentFolderId === "string" && body.parentFolderId ? body.parentFolderId : undefined;
  const h = { Authorization: `Bearer ${auth.token}` };

  if (fileId) {
    // Content-only update; the file keeps its name/parents.
    const res = await fetch(`${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,webViewLink`, {
      method: "PATCH",
      headers: { ...h, "Content-Type": "text/markdown; charset=utf-8" },
      body: bytes,
    });
    if (res.status === 404) return withCookie(Response.json({ error: "not-found" }, { status: 404 }), auth.setCookie);
    if (res.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
    if (!res.ok) return withCookie(new Response(`Couldn't update the Drive file: HTTP ${res.status}.`, { status: 502 }), auth.setCookie);
    const data = (await res.json()) as { id: string; name?: string; webViewLink?: string };
    return withCookie(Response.json({ fileId: data.id, name: data.name ?? name, webViewLink: data.webViewLink }), auth.setCookie);
  }

  // multipart/related: metadata part + raw markdown part.
  const boundary = `mde-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, mimeType: "text/markdown", parents: [parentFolderId ?? "root"] });
  const multipart = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: text/markdown; charset=utf-8\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--\r\n`,
  ]);
  const res = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { ...h, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  if (res.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
  if (!res.ok) return withCookie(new Response(`Couldn't save to Google Drive: HTTP ${res.status}.`, { status: 502 }), auth.setCookie);
  const data = (await res.json()) as { id: string; name?: string; webViewLink?: string };
  return withCookie(Response.json({ fileId: data.id, name: data.name ?? name, webViewLink: data.webViewLink }), auth.setCookie);
}

export async function handleDriveImport(request: Request, env: Env): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  let body: { fileIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  // Bounded on purpose: every id triggers two outbound Google API
  // subrequests and buffers a whole file into the JSON response — an
  // unbounded list (or a multi-hundred-MB file) would exhaust the
  // Worker's subrequest/memory budget. Sequential, so at most one file's
  // bytes are in flight at a time.
  const MAX_DRIVE_FILES = 20;
  const MAX_DRIVE_FILE_BYTES = 5 * 1024 * 1024;
  const fileIds = (Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === "string") : []).slice(0, MAX_DRIVE_FILES);
  const h = { Authorization: `Bearer ${auth.token}` };

  const results: Array<{ fileId: string; ok: true; name: string; contentBase64: string } | { fileId: string; ok: false; error: string }> = [];
  for (const fileId of fileIds) {
    try {
      const metaRes = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=name,mimeType`, { headers: h });
      if (!metaRes.ok) {
        results.push({ fileId, ok: false, error: `meta ${metaRes.status}` });
        continue;
      }
      const meta = (await metaRes.json()) as { name?: string };
      const contentRes = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: h });
      if (!contentRes.ok) {
        results.push({ fileId, ok: false, error: `content ${contentRes.status}` });
        continue;
      }
      const declaredLength = Number(contentRes.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DRIVE_FILE_BYTES) {
        results.push({ fileId, ok: false, error: "file too large" });
        continue;
      }
      const buf = await contentRes.arrayBuffer();
      if (buf.byteLength > MAX_DRIVE_FILE_BYTES) {
        results.push({ fileId, ok: false, error: "file too large" });
        continue;
      }
      results.push({ fileId, name: meta.name ?? "untitled.md", contentBase64: toBase64(buf), ok: true });
    } catch (err) {
      results.push({ fileId, ok: false, error: (err as Error).message });
    }
  }
  return withCookie(Response.json({ results }), auth.setCookie);
}

// ---- Folder sync ----
// A workspace can be backed by an app-created Drive folder. `drive.file`
// means the app can see its own folders/files across devices, but never a
// folder the user made elsewhere; every path below starts from a folder id
// this app created or the user picked.

const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_TREE_DEPTH = 8;
const MAX_TREE_FOLDERS = 200;
const MAX_TREE_FILES = 5000;
const MAX_PUSH_ITEMS = 40;
const MAX_PUSH_SUBFOLDERS = 20;
const MAX_DRIVE_FILE_BYTES = 5 * 1024 * 1024;

interface DriveFileMeta {
  id: string;
  name?: string;
  mimeType?: string;
  headRevisionId?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

function revOf(file: { headRevisionId?: string; modifiedTime?: string }): string {
  return file.headRevisionId || file.modifiedTime || "";
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

class DriveAuthError extends Error {}

// One retry covers Drive's per-user/per-project rate-limit 403s without
// hiding a real permission failure. The body is cloned because the retry
// needs the same request and the caller may need to read the response.
async function driveFetch(url: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const doFetch = () => fetch(url, { ...init, headers });
  let res = await doFetch();
  if (res.status === 403) {
    const text = await res.clone().text();
    if (/rateLimitExceeded|userRateLimitExceeded/.test(text)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      res = await doFetch();
    }
  }
  return res;
}

function sanitizeDriveName(raw: unknown, fallback: string): string {
  const name =
    typeof raw === "string"
      ? raw
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 200)
      : "";
  return name || fallback;
}

function parentPathOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function baseNameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "untitled";
}

async function listDriveFiles(token: string, parentId: string): Promise<DriveFileMeta[]> {
  const q = `'${escapeDriveQuery(parentId)}' in parents and trashed = false`;
  const fields = "files(id,name,mimeType,headRevisionId,modifiedTime),nextPageToken";
  const files: DriveFileMeta[] = [];
  let pageToken: string | undefined;
  do {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const res = await driveFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000${tokenParam}`, {}, token);
    if (res.status === 401) throw new DriveAuthError("reconnect");
    if (!res.ok) throw new Error(`folder list HTTP ${res.status}`);
    const data = (await res.json()) as { files?: DriveFileMeta[]; nextPageToken?: string };
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

export async function handleDriveCreateFolder(request: Request, env: Env): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });

  let body: { workspaceId?: unknown; workspaceName?: unknown; folderName?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const folderName = sanitizeDriveName(body.folderName, "");
  if (!workspaceId || !folderName) return new Response("workspaceId and folderName are required.", { status: 400 });
  const workspaceName = sanitizeDriveName(body.workspaceName, workspaceId);

  const res = await driveFetch(
    `${DRIVE_API}/files?fields=id,name`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: folderName,
        mimeType: FOLDER_MIME,
        appProperties: { mde: "1", mdeWorkspace: workspaceId.slice(0, 100), mdeWorkspaceName: workspaceName.slice(0, 100) },
      }),
    },
    auth.token,
  );
  if (res.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
  if (!res.ok) return withCookie(new Response(`Couldn't create the Drive folder: HTTP ${res.status}.`, { status: 502 }), auth.setCookie);
  const data = (await res.json()) as DriveFileMeta;
  return withCookie(Response.json({ folderId: data.id, folderName: data.name ?? folderName }), auth.setCookie);
}

export async function handleDriveListFolders(request: Request, env: Env): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  // `appProperties has { key='mde' and value='1' }` is the app-folder
  // marker. A folder created by another app/workspace never appears here.
  const q = `mimeType='${FOLDER_MIME}' and appProperties has { key='mde' and value='1' } and trashed=false`;
  const fields = "files(id,name,appProperties,modifiedTime),nextPageToken";
  const files: DriveFileMeta[] = [];
  let pageToken: string | undefined;
  do {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const res = await driveFetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=100${tokenParam}`,
      {},
      auth.token,
    );
    if (res.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
    if (!res.ok) return withCookie(new Response(`Couldn't list Drive folders: HTTP ${res.status}.`, { status: 502 }), auth.setCookie);
    const data = (await res.json()) as { files?: DriveFileMeta[]; nextPageToken?: string };
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return withCookie(
    Response.json({
      folders: files.map((file) => ({
        folderId: file.id,
        folderName: file.name ?? "Untitled folder",
        workspaceId: file.appProperties?.mdeWorkspace ?? null,
        modifiedTime: file.modifiedTime ?? null,
      })),
    }),
    auth.setCookie,
  );
}

export async function handleDriveTree(request: Request, env: Env, folderId: string): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });

  const metaRes = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,appProperties`, {}, auth.token);
  if (metaRes.status === 404) return withCookie(new Response("Folder not found.", { status: 404 }), auth.setCookie);
  if (metaRes.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
  if (!metaRes.ok) return withCookie(new Response(`Couldn't read the Drive folder: HTTP ${metaRes.status}.`, { status: 502 }), auth.setCookie);
  const meta = (await metaRes.json()) as DriveFileMeta;

  const entries: Array<{ fileId: string; path: string; mimeType: string; rev: string }> = [];
  const queue: Array<{ id: string; path: string; depth: number }> = [{ id: folderId, path: "", depth: 0 }];
  let foldersWalked = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (foldersWalked >= MAX_TREE_FOLDERS) {
      truncated = true;
      break;
    }
    const current = queue.shift()!;
    foldersWalked++;
    let files: DriveFileMeta[];
    try {
      files = await listDriveFiles(auth.token, current.id);
    } catch (err) {
      if (err instanceof DriveAuthError) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
      return withCookie(new Response(`Couldn't read the Drive folder: ${(err as Error).message}.`, { status: 502 }), auth.setCookie);
    }
    if (entries.length >= MAX_TREE_FILES) {
      truncated = true;
      break;
    }
    for (const file of files) {
      if (entries.length >= MAX_TREE_FILES) {
        truncated = true;
        break;
      }
      const path = current.path ? `${current.path}/${file.name ?? "untitled"}` : (file.name ?? "untitled");
      if (file.mimeType === FOLDER_MIME) {
        if (current.depth + 1 < MAX_TREE_DEPTH) queue.push({ id: file.id, path, depth: current.depth + 1 });
        else truncated = true;
        continue;
      }
      entries.push({ fileId: file.id, path, mimeType: file.mimeType ?? "application/octet-stream", rev: revOf(file) });
    }
  }

  return withCookie(
    Response.json({
      folderId: meta.id,
      folderName: meta.name ?? "Drive folder",
      workspaceId: meta.appProperties?.mdeWorkspace ?? null,
      entries,
      truncated,
    }),
    auth.setCookie,
  );
}

export async function handleDriveFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {}, auth.token);
  if (res.status === 404) return withCookie(new Response("File not found.", { status: 404 }), auth.setCookie);
  if (res.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
  if (!res.ok) return withCookie(new Response(`Couldn't download the Drive file: HTTP ${res.status}.`, { status: 502 }), auth.setCookie);
  const declaredLength = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DRIVE_FILE_BYTES) {
    return withCookie(new Response("File is too large to sync from Google Drive.", { status: 413 }), auth.setCookie);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_DRIVE_FILE_BYTES) {
    return withCookie(new Response("File is too large to sync from Google Drive.", { status: 413 }), auth.setCookie);
  }
  return withCookie(Response.json({ contentBase64: toBase64(buf) }), auth.setCookie);
}

interface PushCreate {
  path: string;
  mimeType?: string;
  contentBase64: string;
}
interface PushUpdate {
  fileId: string;
  path?: string;
  mimeType?: string;
  contentBase64: string;
}
interface PushResultItem {
  path: string;
  op: "create" | "update" | "delete";
  ok: boolean;
  fileId?: string;
  rev?: string;
  error?: string;
}

export async function handleDrivePush(request: Request, env: Env, folderId: string): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });

  let body: {
    ensureSubfolders?: unknown;
    creates?: unknown;
    updates?: unknown;
    deletes?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const ensureSubfolders = (Array.isArray(body.ensureSubfolders) ? body.ensureSubfolders.filter((x): x is string => typeof x === "string") : []).slice(
    0,
    MAX_PUSH_SUBFOLDERS,
  );
  const creates = (Array.isArray(body.creates) ? body.creates : []).filter(
    (x): x is PushCreate => !!x && typeof x === "object" && typeof (x as PushCreate).path === "string" && typeof (x as PushCreate).contentBase64 === "string",
  );
  const updates = (Array.isArray(body.updates) ? body.updates : []).filter(
    (x): x is PushUpdate => !!x && typeof x === "object" && typeof (x as PushUpdate).fileId === "string" && typeof (x as PushUpdate).contentBase64 === "string",
  );
  const deletes = Array.isArray(body.deletes) ? body.deletes.filter((x): x is string => typeof x === "string") : [];
  if (creates.length + updates.length + deletes.length > MAX_PUSH_ITEMS) {
    return withCookie(new Response("Too many files in one Drive push.", { status: 413 }), auth.setCookie);
  }

  const folderCache = new Map<string, string>([[folderId, folderId]]);
  const token = auth.token;

  async function ensureFolderPath(path: string): Promise<string> {
    const segments = path.split("/").filter((segment) => segment && segment !== "." && segment !== "..");
    let parent = folderId;
    for (const segment of segments) {
      const key = `${parent}/${segment}`;
      const cached = folderCache.get(key);
      if (cached) {
        parent = cached;
        continue;
      }
      const q = `'${escapeDriveQuery(parent)}' in parents and name = '${escapeDriveQuery(segment)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
      const listRes = await driveFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=10`, {}, token);
      if (listRes.status === 401) throw new DriveAuthError("reconnect");
      if (!listRes.ok) throw new Error(`folder lookup HTTP ${listRes.status}`);
      const listed = (await listRes.json()) as { files?: { id: string }[] };
      let id = listed.files?.[0]?.id;
      if (!id) {
        const createRes = await driveFetch(
          `${DRIVE_API}/files?fields=id`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: segment, mimeType: FOLDER_MIME, parents: [parent] }),
          },
          token,
        );
        if (createRes.status === 401) throw new DriveAuthError("reconnect");
        if (!createRes.ok) throw new Error(`folder create HTTP ${createRes.status}`);
        const created = (await createRes.json()) as { id: string };
        id = created.id;
      }
      folderCache.set(key, id);
      parent = id;
    }
    return parent;
  }

  // Fail fast if an entire required subtree can't be made — every create
  // below would fail otherwise, wasting subrequests to produce the same
  // error N times.
  for (const subfolder of ensureSubfolders) {
    try {
      await ensureFolderPath(subfolder);
    } catch (err) {
      if (err instanceof DriveAuthError) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
      // Keep going; each affected create records the real per-file error.
      break;
    }
  }

  const results: PushResultItem[] = [];

  try {
    for (const create of creates) {
      const path = create.path;
      try {
        const bytes = fromBase64(create.contentBase64);
        if (bytes.byteLength > MAX_DRIVE_FILE_BYTES) throw new Error("file too large");
        const mimeType = typeof create.mimeType === "string" && create.mimeType ? create.mimeType : "application/octet-stream";
        const parent = await ensureFolderPath(parentPathOf(path));
        const name = sanitizeDriveName(baseNameOf(path), "untitled");
        const boundary = `mde-${crypto.randomUUID()}`;
        const metadata = JSON.stringify({ name, mimeType, parents: [parent] });
        const multipart = new Blob([
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
          `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
          bytes,
          `\r\n--${boundary}--\r\n`,
        ]);
        const res = await driveFetch(
          `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,headRevisionId,modifiedTime`,
          { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart },
          auth.token,
        );
        if (res.status === 401) throw new DriveAuthError("reconnect");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DriveFileMeta;
        results.push({ path, op: "create", ok: true, fileId: data.id, rev: revOf(data) });
      } catch (err) {
        if (err instanceof DriveAuthError) throw err;
        results.push({ path, op: "create", ok: false, error: (err as Error).message });
      }
    }

    for (const update of updates) {
      const path = typeof update.path === "string" && update.path ? update.path : update.fileId;
      try {
        const bytes = fromBase64(update.contentBase64);
        if (bytes.byteLength > MAX_DRIVE_FILE_BYTES) throw new Error("file too large");
        const res = await driveFetch(
          `${DRIVE_UPLOAD}/files/${encodeURIComponent(update.fileId)}?uploadType=media&fields=id,headRevisionId,modifiedTime`,
          { method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: bytes },
          auth.token,
        );
        if (res.status === 401) throw new DriveAuthError("reconnect");
        if (res.status === 404) throw new Error("not-found");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DriveFileMeta;
        results.push({ path, op: "update", ok: true, fileId: data.id || update.fileId, rev: revOf(data) });
      } catch (err) {
        if (err instanceof DriveAuthError) throw err;
        results.push({ path, op: "update", ok: false, fileId: update.fileId, error: (err as Error).message });
      }
    }

    for (const fileId of deletes) {
      try {
        const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, auth.token);
        if (res.status === 401) throw new DriveAuthError("reconnect");
        // Already gone is success: the caller's goal (file no longer
        // exists) is satisfied, and a retry shouldn't keep reporting it.
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
        results.push({ path: fileId, op: "delete", ok: true, fileId });
      } catch (err) {
        if (err instanceof DriveAuthError) throw err;
        results.push({ path: fileId, op: "delete", ok: false, fileId, error: (err as Error).message });
      }
    }
  } catch (err) {
    if (err instanceof DriveAuthError) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
    throw err;
  }

  const synced = results.filter((item) => item.ok).length;
  return withCookie(Response.json({ results, synced, failed: results.length - synced }), auth.setCookie);
}

// ---- Drive revisions (Version History) ----
// Drive exposes per-file revisions only. The list endpoint does not carry
// media, so preview/restore uses the separate revision-content endpoint.

interface DriveRevisionMeta {
  id: string;
  modifiedTime?: string;
  lastModifyingUser?: { displayName?: string };
}

export async function handleDriveRevisions(request: Request, env: Env, fileId: string): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  const fields = "revisions(id,modifiedTime,lastModifyingUser(displayName)),nextPageToken";
  const revisions: DriveRevisionMeta[] = [];
  let pageToken: string | undefined;
  do {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const res = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/revisions?fields=${encodeURIComponent(fields)}&pageSize=1000${tokenParam}`,
      {},
      auth.token,
    );
    if (res.status === 404) return withCookie(new Response("File not found.", { status: 404 }), auth.setCookie);
    if (res.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
    if (!res.ok) return withCookie(new Response(`Couldn't list Drive revisions: HTTP ${res.status}.`, { status: 502 }), auth.setCookie);
    const data = (await res.json()) as { revisions?: DriveRevisionMeta[]; nextPageToken?: string };
    revisions.push(...(data.revisions ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const mapped = revisions
    .filter((revision) => !!revision.id)
    .map((revision) => ({
      revId: revision.id,
      modifiedTime: revision.modifiedTime ?? "",
      author: revision.lastModifyingUser?.displayName ?? "Google Drive",
    }));
  // A file with one revision has no history to show — the current file
  // itself is already the live document.
  return withCookie(Response.json({ revisions: mapped.length <= 1 ? [] : mapped }), auth.setCookie);
}

export async function handleDriveRevisionContent(request: Request, env: Env, fileId: string, revId: string): Promise<Response> {
  const auth = await getGoogleAccessToken(request, env);
  if (!auth) return new Response("Reconnect Google Drive.", { status: 401 });
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revId)}?alt=media`, {}, auth.token);
  if (res.status === 404) return withCookie(new Response("Revision not found.", { status: 404 }), auth.setCookie);
  if (res.status === 401) return withCookie(new Response("Reconnect Google Drive.", { status: 401 }), auth.setCookie);
  if (!res.ok) return withCookie(new Response(`Couldn't download the Drive revision: HTTP ${res.status}.`, { status: 502 }), auth.setCookie);
  const declaredLength = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DRIVE_FILE_BYTES) {
    return withCookie(new Response("Revision is too large to preview.", { status: 413 }), auth.setCookie);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_DRIVE_FILE_BYTES) {
    return withCookie(new Response("Revision is too large to preview.", { status: 413 }), auth.setCookie);
  }
  return withCookie(Response.json({ contentBase64: toBase64(buf) }), auth.setCookie);
}
