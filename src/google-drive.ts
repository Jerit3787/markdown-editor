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
  return withCookie(Response.json({ token: auth.token, apiKey: env.GOOGLE_API_KEY }), auth.setCookie);
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
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === "string") : [];
  const h = { Authorization: `Bearer ${auth.token}` };

  const results = await Promise.all(
    fileIds.map(async (fileId) => {
      try {
        const metaRes = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=name,mimeType`, { headers: h });
        if (!metaRes.ok) return { fileId, ok: false as const, error: `meta ${metaRes.status}` };
        const meta = (await metaRes.json()) as { name?: string };
        const contentRes = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: h });
        if (!contentRes.ok) return { fileId, ok: false as const, error: `content ${contentRes.status}` };
        return { fileId, name: meta.name ?? "untitled.md", contentBase64: toBase64(await contentRes.arrayBuffer()), ok: true as const };
      } catch (err) {
        return { fileId, ok: false as const, error: (err as Error).message };
      }
    }),
  );
  return withCookie(Response.json({ results }), auth.setCookie);
}
