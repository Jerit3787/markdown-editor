import { GOOGLE_SESSION_COOKIE, GOOGLE_STATE_COOKIE, encryptJSON, decryptJSON, getCookie, cookieHeader, popupResponse, popupHtml } from "./auth.js";
import type { Env, GoogleSessionData } from "./env";

// Google OAuth 2.0 web-server flow for the Drive integration — mirrors
// src/github-auth.ts, popup-based. Owns the mde_google_session cookie
// (a { refreshToken, accessToken, accessTokenExp } grant), kept entirely
// separate from the GitHub session. `drive.file` scope only — never
// request `drive` or any restricted scope.

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
// The refresh token itself lasts ~6 months idle; the cookie's own life is
// shorter so a long-dormant connection re-prompts rather than 401-ing.
const GOOGLE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function notConfigured(env: Env): boolean {
  return !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET;
}

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/api/auth/google/callback`;
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function handleGoogleConnect(request: Request, env: Env): Promise<Response> {
  if (notConfigured(env)) return new Response("Google Drive is not configured.", { status: 503 });
  const state = crypto.randomUUID();
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", redirectUri(request));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", DRIVE_SCOPE);
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("prompt", "consent"); // always re-issue a refresh token
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("include_granted_scopes", "true");
  const headers = new Headers({ Location: authorize.toString() });
  headers.append("Set-Cookie", cookieHeader(GOOGLE_STATE_COOKIE, state, { maxAge: 600 }));
  return new Response(null, { status: 302, headers });
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function exchange(env: Env, params: Record<string, string>): Promise<GoogleTokenResponse | null> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }),
  });
  const body = await safeJson<GoogleTokenResponse>(res);
  if (!res.ok || !body || body.error) return null;
  return body;
}

export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  if (notConfigured(env)) return new Response("Google Drive is not configured.", { status: 503 });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = getCookie(request, GOOGLE_STATE_COOKIE);
  if (!code || !state || state !== expected) return popupResponse("google", false, "Invalid state.");

  const tok = await exchange(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(request) });
  if (!tok || !tok.access_token) return popupResponse("google", false, "Google sign-in failed.");
  if (!tok.refresh_token) {
    // prompt=consent should always return one; if Google still withholds it
    // the session would be unrefreshable — better to fail loudly.
    return popupResponse("google", false, "Google didn't return a refresh token — disconnect any prior grant in your Google account and try again.");
  }

  const session: GoogleSessionData = {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    accessTokenExp: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
  const cookie = await encryptJSON(env, session, GOOGLE_SESSION_TTL_MS);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  headers.append("Set-Cookie", cookieHeader(GOOGLE_SESSION_COOKIE, cookie, { maxAge: GOOGLE_SESSION_TTL_MS / 1000 }));
  headers.append("Set-Cookie", cookieHeader(GOOGLE_STATE_COOKIE, "", { maxAge: 0 }));
  return new Response(popupHtml("google", true, null), { headers });
}

// A live Drive access token, refreshing transparently if the stored one
// is within 60s of expiry. When it refreshes, the caller MUST thread the
// returned `setCookie` onto its own Response so the browser keeps the
// re-encrypted session. `null` → no session or the refresh failed
// (revoked / ~6-month idle / password change) → the caller 401s.
export async function getGoogleAccessToken(request: Request, env: Env): Promise<{ token: string; setCookie?: string } | null> {
  if (notConfigured(env)) return null;
  const raw = getCookie(request, GOOGLE_SESSION_COOKIE);
  if (!raw) return null;
  const session = await decryptJSON<GoogleSessionData>(env, raw);
  if (!session) return null;

  if (session.accessTokenExp - Date.now() > 60_000) return { token: session.accessToken };

  const tok = await exchange(env, { grant_type: "refresh_token", refresh_token: session.refreshToken });
  if (!tok || !tok.access_token) return null;
  const next: GoogleSessionData = {
    refreshToken: session.refreshToken,
    accessToken: tok.access_token,
    accessTokenExp: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
  const cookie = await encryptJSON(env, next, GOOGLE_SESSION_TTL_MS);
  return { token: tok.access_token, setCookie: cookieHeader(GOOGLE_SESSION_COOKIE, cookie, { maxAge: GOOGLE_SESSION_TTL_MS / 1000 }) };
}

export async function handleGoogleStatus(request: Request, env: Env): Promise<Response> {
  const raw = getCookie(request, GOOGLE_SESSION_COOKIE);
  const session = raw ? await decryptJSON<GoogleSessionData>(env, raw) : null;
  return Response.json({ connected: !!session });
}

export async function handleGoogleDisconnect(request: Request, env: Env): Promise<Response> {
  const raw = getCookie(request, GOOGLE_SESSION_COOKIE);
  const session = raw ? await decryptJSON<GoogleSessionData>(env, raw) : null;
  if (session) {
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(session.refreshToken)}`, { method: "POST" });
    } catch {
      /* best effort — the cookie is cleared regardless */
    }
  }
  const headers = new Headers();
  headers.append("Set-Cookie", cookieHeader(GOOGLE_SESSION_COOKIE, "", { maxAge: 0 }));
  return new Response(null, { status: 204, headers });
}
