import { GOOGLE_SESSION_COOKIE, GOOGLE_STATE_COOKIE, encryptJSON, decryptJSON, getCookie, cookieHeader, popupResponse } from "./auth.js";
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
