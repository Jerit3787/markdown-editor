// Encrypted-cookie session helper. The GitHub access token never reaches
// client JS: it's AES-GCM encrypted (key derived from the SESSION_SECRET
// Worker secret) and stored in an HttpOnly cookie, so an XSS bug in the
// editor can't exfiltrate it — only this Worker can decrypt it.
export const SESSION_COOKIE = "mde_gh_session";
export const STATE_COOKIE = "mde_oauth_state";

async function deriveKey(env) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_SECRET));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64Url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function encryptSession(env, data) {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

export async function decryptSession(env, value) {
  try {
    const [ivPart, ctPart] = value.split(".");
    const key = await deriveKey(env);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, key, fromBase64Url(ctPart));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (err) {
    return null;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function cookieHeader(name, value, { maxAge } = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax`;
  if (maxAge != null) cookie += `; Max-Age=${maxAge}`;
  return cookie;
}
