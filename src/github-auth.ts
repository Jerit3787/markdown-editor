import { SESSION_COOKIE, STATE_COOKIE, encryptSession, decryptSession, getCookie, cookieHeader, popupHtml, popupResponse } from "./auth.js";
import type { Env, SessionData } from "./env";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
// GitHub rejects any request without a User-Agent with a plain-text 403
// ("Request forbidden by administrative rules") instead of JSON — Workers'
// fetch doesn't send one by default.
const USER_AGENT = "markdown-editor-app (+https://editor.danplace.tech)";

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  login?: string;
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = crypto.randomUUID();

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", `${url.origin}/api/auth/github/callback`);
  // "repo" and "gist" are independent OAuth scopes — requesting only one
  // silently drops the other for anyone who (re)authorizes after a scope
  // change, since GitHub's grant reflects whatever was last requested, not
  // a union of every scope this app has ever asked for. This app relies on
  // both: repo-sync needs "repo", Gist publish/update needs "gist". See
  // repo-sync-ui.ts's hasRepoScope/requireRepoScope for the client-side
  // check that catches a stale grant missing "repo"; gist.ts's
  // hasGistScope/requireGistScope is the mirror for "gist".
  authorizeUrl.searchParams.set("scope", "repo gist");
  authorizeUrl.searchParams.set("state", state);

  const headers = new Headers({ Location: authorizeUrl.toString() });
  headers.append("Set-Cookie", cookieHeader(STATE_COOKIE, state, { maxAge: 600 }));
  return new Response(null, { status: 302, headers });
}

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, STATE_COOKIE);

  if (!code || !state || state !== expectedState) {
    return popupResponse("github", false, "Invalid state.");
  }

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/github/callback`,
    }),
  });
  const tokenData = await safeJson<TokenResponse>(tokenRes);
  if (!tokenData || !tokenData.access_token) {
    const detail = (tokenData && (tokenData.error_description || tokenData.error)) || `HTTP ${tokenRes.status}`;
    return popupResponse("github", false, detail);
  }

  const userRes = await fetch(`${API}/user`, { headers: ghHeaders(tokenData.access_token) });
  const userData = await safeJson<GitHubUser>(userRes);
  if (!userData || !userData.login) {
    return popupResponse("github", false, "Could not read GitHub profile.");
  }

  const session = await encryptSession(env, { token: tokenData.access_token, username: userData.login });
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, session, { maxAge: 60 * 60 * 24 * 30 }));
  headers.append("Set-Cookie", cookieHeader(STATE_COOKIE, "", { maxAge: 0 }));
  return new Response(popupHtml("github", true, null), { headers });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (session && session.token) {
    // Best-effort: revoking the grant server-side is a nice-to-have on
    // top of clearing the local session below, not a precondition for
    // it. A network blip or GitHub-side hiccup here must never leave
    // the user still signed in locally with no indication logout failed.
    try {
      const credentials = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
      await fetch(`${API}/applications/${env.GITHUB_CLIENT_ID}/grant`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${credentials}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: session.token }),
      });
    } catch (err) {
      // ignored — see comment above
    }
  }

  const headers = new Headers();
  headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0 }));
  if (request.method === "POST") {
    return new Response(null, { status: 200, headers });
  }
  headers.set("Location", "/");
  return new Response(null, { status: 302, headers });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return Response.json({ connected: false, scopes: [] });

  // Only a 401 from GitHub means the token is definitely invalid/revoked
  // — a 403 (rate-limited), a transient 5xx, or the fetch itself failing
  // outright don't mean that, and signing the user out for any of those
  // would be a false positive. Fail open: trust the locally-decrypted
  // session unless GitHub explicitly says the token is no good.
  let scopes: string[] = [];
  try {
    const userRes = await fetch(`${API}/user`, { headers: ghHeaders(session.token) });
    if (userRes.status === 401) {
      const headers = new Headers();
      headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0 }));
      return Response.json({ connected: false, scopes: [] }, { headers });
    }
    const scopeHeader = userRes.headers.get("X-OAuth-Scopes");
    if (scopeHeader)
      scopes = scopeHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  } catch (err) {
    // Couldn't reach GitHub to verify — fall through and trust the
    // local session rather than signing the user out over a network blip.
  }

  return Response.json({ connected: true, username: session.username, scopes });
}

export async function handleGistCreate(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const body = await request.text();
  const res = await fetch(`${API}/gists`, {
    method: "POST",
    headers: { ...ghHeaders(session.token), "Content-Type": "application/json" },
    body,
  });
  return proxyJson(res);
}

export async function handleGistUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const body = await request.text();
  const res = await fetch(`${API}/gists/${id}`, {
    method: "PATCH",
    headers: { ...ghHeaders(session.token), "Content-Type": "application/json" },
    body,
  });
  return proxyJson(res);
}

export async function handleGistList(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/gists?per_page=100`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}

export async function handleGistGet(request: Request, env: Env, id: string): Promise<Response> {
  const session = await getSession(request, env);
  const headers = session ? ghHeaders(session.token) : { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT };
  const res = await fetch(`${API}/gists/${id}`, { headers });
  return proxyJson(res);
}

async function getSession(request: Request, env: Env): Promise<SessionData | null> {
  const cookie = getCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  return decryptSession(env, cookie);
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

async function proxyJson(res: Response): Promise<Response> {
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    return null;
  }
}
