import { getGoogleAccessToken } from "./google-auth.js";
import type { Env } from "./env";

// Drive API v3 proxy behind the mde_google_session cookie. This plan:
// picker-token + import. Later plans add folder / tree / push / export /
// revisions.

const DRIVE_API = "https://www.googleapis.com/drive/v3";

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
