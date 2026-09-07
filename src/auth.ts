import type { Env, SessionData } from "./env";

// Encrypted-cookie session helper. The GitHub access token never reaches
// client JS: it's AES-GCM encrypted (key derived from the SESSION_SECRET
// Worker secret) and stored in an HttpOnly cookie, so an XSS bug in the
// editor can't exfiltrate it — only this Worker can decrypt it.
export const SESSION_COOKIE = "mde_gh_session";
export const STATE_COOKIE = "mde_oauth_state";
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

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
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

// Generic AES-GCM-encrypted-JSON helper. `ttlMs` is stamped into the
// ciphertext as `exp` and enforced by decryptJSON, so the cookie has a
// real lifetime even if the browser is told to keep it forever (see the
// long comment above SESSION_TTL_MS's definition). Both the GitHub
// session (encryptSession, below) and the Google Drive grant
// (src/google-auth.ts) ride this.
export async function encryptJSON<T>(env: Env, data: T, ttlMs: number = SESSION_TTL_MS): Promise<string> {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = { ...data, exp: Date.now() + ttlMs };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `${toBase64Url(iv.buffer)}.${toBase64Url(ciphertext)}`;
}

export async function decryptJSON<T extends { exp?: number }>(env: Env, value: string): Promise<T | null> {
  try {
    const [ivPart, ctPart] = value.split(".");
    if (!ivPart || !ctPart) return null;
    const key = await deriveKey(env);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ctPart));
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as T;
    // A value minted before `exp` existed carries no verifiable lifetime
    // at all — treat that as expired rather than as unlimited. The cost is
    // one re-authentication for anyone holding a pre-existing cookie.
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
    return parsed;
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

function escapeHtml(str: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str).replace(/[&<>"']/g, (c) => map[c] as string);
}

// The OAuth popup's final page: postMessages the result to window.opener
// and closes itself (success closes immediately; failure shows the reason
// for a couple seconds first). `kind` selects which auth flow this is —
// the client listeners key off the message `type`.
export function popupHtml(kind: "github" | "google", ok: boolean, message: string | null): string {
  const type = kind === "github" ? "mde-github-auth" : "mde-google-auth";
  // JSON.stringify leaves "<" / ">" / "&" alone, so a message containing
  // "</script>" would break out of this inline script — escape the three
  // tag-boundary characters.
  const payload = JSON.stringify({ type, ok, message: message || null })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const title = kind === "github" ? "GitHub sign-in" : "Google Drive";
  const okVerb = kind === "github" ? "Signed in" : "Connected";
  const failVerb = kind === "github" ? "Sign-in" : "Connection";
  const body = ok ? `${okVerb} — this window will close automatically.` : `${failVerb} failed: ${escapeHtml(message || "unknown error")}`;
  const closeDelay = ok ? 0 : 2500;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head><body style="font:14px system-ui;padding:24px;color:${ok ? "#333" : "#c0392b"}">${body}<script>
    if (window.opener) window.opener.postMessage(${payload}, window.location.origin);
    setTimeout(function () { window.close(); }, ${closeDelay});
  </script></body></html>`;
}

export function popupResponse(kind: "github" | "google", ok: boolean, message: string): Response {
  return new Response(popupHtml(kind, ok, message), { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
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
