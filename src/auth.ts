import type { Env, SessionData } from "./env";

// Encrypted-cookie session helper. The GitHub access token never reaches
// client JS: it's AES-GCM encrypted (key derived from the SESSION_SECRET
// Worker secret) and stored in an HttpOnly cookie, so an XSS bug in the
// editor can't exfiltrate it — only this Worker can decrypt it.
export const SESSION_COOKIE = "mde_gh_session";
export const STATE_COOKIE = "mde_oauth_state";

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

export async function encryptSession(env: Env, data: SessionData): Promise<string> {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: SessionData = { ...data, exp: Date.now() + SESSION_TTL_MS };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `${toBase64Url(iv.buffer)}.${toBase64Url(ciphertext)}`;
}

export async function decryptSession(env: Env, value: string): Promise<SessionData | null> {
  try {
    const [ivPart, ctPart] = value.split(".");
    if (!ivPart || !ctPart) return null;
    const key = await deriveKey(env);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ctPart));
    const session = JSON.parse(new TextDecoder().decode(plaintext)) as SessionData;
    // A session minted before `exp` existed carries no verifiable lifetime
    // at all — treat that as expired rather than as unlimited. The cost is
    // one re-authentication for anyone holding a pre-existing cookie.
    if (typeof session.exp !== "number" || session.exp <= Date.now()) return null;
    return session;
  } catch (err) {
    return null;
  }
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
