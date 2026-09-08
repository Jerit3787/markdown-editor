const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TICKET_TTL_MS = 15 * 60 * 1000;

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyTurnstileToken(token: string, remoteIp: string | null, secret: string): Promise<boolean> {
  try {
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token);
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export async function mintJoinTicket(workspaceId: string, secret: string, now: number): Promise<string> {
  const payload = JSON.stringify({ w: workspaceId, exp: now + TICKET_TTL_MS });
  const sig = await hmac(secret, `join-ticket:${payload}`);
  return `${b64urlEncode(new TextEncoder().encode(payload))}.${b64urlEncode(sig)}`;
}

export async function verifyJoinTicket(ticket: string | null, workspaceId: string, secret: string, now: number): Promise<boolean> {
  if (!ticket) return false;
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  let payload: string;
  let gotSig: Uint8Array;
  try {
    payload = new TextDecoder().decode(b64urlDecode(parts[0]));
    gotSig = b64urlDecode(parts[1]);
  } catch {
    return false;
  }
  const expectedSig = await hmac(secret, `join-ticket:${payload}`);
  if (!timingSafeEqual(expectedSig, gotSig)) return false;
  let parsed: { w?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(payload) as { w?: unknown; exp?: unknown };
  } catch {
    return false;
  }
  return parsed.w === workspaceId && typeof parsed.exp === "number" && parsed.exp > now;
}
