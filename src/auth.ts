import type { Env, SessionData } from "./env";

// Encrypted-cookie session helper. The GitHub access token never reaches
// client JS: it's AES-GCM encrypted (key derived from the SESSION_SECRET
// Worker secret) and stored in an HttpOnly cookie, so an XSS bug in the
// editor can't exfiltrate it — only this Worker can decrypt it.
export const SESSION_COOKIE = "mde_gh_session";
export const STATE_COOKIE = "mde_oauth_state";
// The Google Drive connection's own cookie pair (src/google-auth.ts) —
// entirely independent of the GitHub session above.
export const GOOGLE_SESSION_COOKIE = "mde_google_session";
export const GOOGLE_STATE_COOKIE = "mde_google_oauth_state";

// The encrypted cookie is a bearer credential: whoever can replay the
// string is the session. `Max-Age` on the Set-Cookie header only asks the
// *browser* to forget it, so a value copied off a machine (or out of a
// backup, or a shared profile) would otherwise stay valid until
// SESSION_SECRET is rotated. Stamping the expiry inside the ciphertext —
// where it can't be edited without the key — and enforcing it on the way
// back in gives the cookie a real lifetime that matches the advertised
// one. Keep this in sync with the Max-Age handleCallback sets.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function deriveKey(env: Env): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_SECRET));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): ArrayBuffer {
  const padded = str
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Generic AES-GCM-encrypted-JSON cookie helper. `ttlMs` is stamped into
// the ciphertext as `exp` and enforced by decryptJSON on the way back in,
// so the cookie has a real lifetime even if the browser is told (via
// Max-Age) to keep it forever — see the SESSION_TTL_MS comment above.
// encryptSession / decryptSession are thin wrappers; src/google-auth.ts
// uses this directly for the mde_google_session cookie.
export async function encryptJSON<T>(env: Env, data: T, ttlMs: number = SESSION_TTL_MS): Promise<string> {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = { ...data, exp: Date.now() + ttlMs };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `${toBase64Url(iv.buffer)}.${toBase64Url(ciphertext)}`;
}

export async function decryptJSON<T>(env: Env, value: string): Promise<(T & { exp: number }) | null> {
  try {
    const [ivPart, ctPart] = value.split(".");
    if (!ivPart || !ctPart) return null;
    const key = await deriveKey(env);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ctPart));
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as T & { exp?: number };
    // A payload minted before `exp` existed carries no verifiable lifetime
    // at all — treat that as expired rather than as unlimited. The cost is
    // one re-authentication for anyone holding a pre-existing cookie.
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
    return parsed as T & { exp: number };
  } catch (err) {
    return null;
  }
}

export async function encryptSession(env: Env, data: SessionData): Promise<string> {
  return encryptJSON(env, data);
}

export async function decryptSession(env: Env, value: string): Promise<SessionData | null> {
  return decryptJSON<SessionData>(env, value);
}

// A signed (not encrypted) identity label for an anonymous collaborator.
// The payload isn't secret — anonId/anonName are visible to every
// collaborator as an entry's `author` — it only needs to be tamper-proof,
// so HMAC-SHA256 over SESSION_SECRET, not AES-GCM.
const ANON_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function anonHmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signAnonToken(env: Env, data: { anonId: string; anonName: string }): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...data, iat: Date.now() })));
  const sig = await crypto.subtle.sign("HMAC", await anonHmacKey(env), new TextEncoder().encode(body));
  return `${body}.${toBase64Url(sig)}`;
}

export async function verifyAnonToken(env: Env, token: string): Promise<{ anonId: string; anonName: string } | null> {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify("HMAC", await anonHmacKey(env), fromBase64Url(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { anonId?: unknown; anonName?: unknown; iat?: unknown };
    if (typeof p.anonId !== "string" || typeof p.anonName !== "string" || typeof p.iat !== "number") return null;
    if (!p.anonId.startsWith("anon:")) return null;
    if (p.iat + ANON_TOKEN_TTL_MS <= Date.now()) return null;
    return { anonId: p.anonId, anonName: p.anonName };
  } catch {
    return null;
  }
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

export function cookieHeader(name: string, value: string, { maxAge }: { maxAge?: number } = {}): string {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax`;
  if (maxAge != null) cookie += `; Max-Age=${maxAge}`;
  if (maxAge === 0) cookie += `; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  return cookie;
}

function escapeHtml(str: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str).replace(/[&<>"']/g, (c) => map[c] as string);
}

// The OAuth popup window's final page: postMessages the result to
// window.opener and closes itself — success closes immediately, failure
// shows the reason for ~2.5s first. `kind` selects the `postMessage`
// `type` the client listeners key off ("mde-github-auth" — see
// GithubSignInModal.svelte — / "mde-google-auth" — see drive-files.ts).
// Moved here from github-auth.ts so both OAuth flows share it.
export function popupHtml(kind: "github" | "google", ok: boolean, message: string | null): string {
  const type = kind === "github" ? "mde-github-auth" : "mde-google-auth";
  // JSON.stringify escapes quotes and backslashes but leaves "<" and "/"
  // alone, so a message containing "</script>" would close this inline
  // script early and land as live markup on the app's own origin. The
  // message comes from an OAuth token endpoint rather than a request
  // param, but "upstream text is safe to inline" isn't worth depending
  // on — escape the three characters that can start a tag boundary.
  const payload = JSON.stringify({ type, ok, message: message || null })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const label = kind === "github" ? "GitHub sign-in" : "Google Drive";
  const body = ok
    ? `${kind === "github" ? "Signed in" : "Connected"} — this window will close automatically.`
    : `${kind === "github" ? "Sign-in" : "Connection"} failed: ${escapeHtml(message || "unknown error")}`;
  const closeDelay = ok ? 0 : 2500;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${label}</title></head><body style="font:14px system-ui;padding:24px;color:${ok ? "#333" : "#c0392b"}">${body}<script>
    if (window.opener) window.opener.postMessage(${payload}, window.location.origin);
    setTimeout(function () { window.close(); }, ${closeDelay});
  </script></body></html>`;
}

export function popupResponse(kind: "github" | "google", ok: boolean, message: string): Response {
  return new Response(popupHtml(kind, ok, message), { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
