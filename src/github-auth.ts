import { SESSION_COOKIE, STATE_COOKIE, encryptSession, decryptSession, getCookie, cookieHeader } from "./auth.js";
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
    return popupResponse(false, "Invalid state.");
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
    return popupResponse(false, detail);
  }

  const userRes = await fetch(`${API}/user`, { headers: ghHeaders(tokenData.access_token) });
  const userData = await safeJson<GitHubUser>(userRes);
  if (!userData || !userData.login) {
    return popupResponse(false, "Could not read GitHub profile.");
  }

  const session = await encryptSession(env, { token: tokenData.access_token, username: userData.login });
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, session, { maxAge: 60 * 60 * 24 * 30 }));
  headers.append("Set-Cookie", cookieHeader(STATE_COOKIE, "", { maxAge: 0 }));
  return new Response(popupHtml(true, null), { headers });
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

// The login/callback round trip happens in a popup window (see
// window.MDE.openGithubSignIn in app.js), not a full-page redirect — this
// is what the popup's final page renders. It hands the result back to the
// opener via postMessage and closes itself: success closes immediately,
// failure shows the reason for a couple seconds first so it's not just a
// window vanishing with no explanation.
function popupHtml(ok: boolean, message: string | null): string {
  // JSON.stringify escapes quotes and backslashes but leaves "<" and "/"
  // alone, so a message containing "</script>" would close this inline
  // script early and land as live markup on the app's own origin. The
  // message comes from GitHub's token endpoint rather than directly from a
  // request param, but "upstream text is safe to inline" isn't a property
  // worth depending on — escape the three characters that can start a tag
  // boundary instead.
  const payload = JSON.stringify({ type: "mde-github-auth", ok, message: message || null })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const body = ok ? "Signed in — this window will close automatically." : `Sign-in failed: ${escapeHtml(message || "unknown error")}`;
  const closeDelay = ok ? 0 : 2500;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GitHub sign-in</title></head><body style="font:14px system-ui;padding:24px;color:${ok ? "#333" : "#c0392b"}">${body}<script>
    if (window.opener) window.opener.postMessage(${payload}, window.location.origin);
    setTimeout(function () { window.close(); }, ${closeDelay});
  </script></body></html>`;
}

function popupResponse(ok: boolean, message: string): Response {
  return new Response(popupHtml(ok, message), { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(str: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str).replace(/[&<>"']/g, (c) => map[c] as string);
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
