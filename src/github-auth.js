import { SESSION_COOKIE, STATE_COOKIE, encryptSession, decryptSession, getCookie, cookieHeader } from "./auth.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
// GitHub rejects any request without a User-Agent with a plain-text 403
// ("Request forbidden by administrative rules") instead of JSON — Workers'
// fetch doesn't send one by default.
const USER_AGENT = "markdown-editor-app (+https://editor.danplace.tech)";

export async function handleLogin(request, env) {
  const url = new URL(request.url);
  const state = crypto.randomUUID();

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", `${url.origin}/api/auth/github/callback`);
  authorizeUrl.searchParams.set("scope", "gist");
  authorizeUrl.searchParams.set("state", state);

  const headers = new Headers({ Location: authorizeUrl.toString() });
  headers.append("Set-Cookie", cookieHeader(STATE_COOKIE, state, { maxAge: 600 }));
  return new Response(null, { status: 302, headers });
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, STATE_COOKIE);

  if (!code || !state || state !== expectedState) {
    return new Response("GitHub sign-in failed: invalid state.", { status: 400 });
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
  const tokenData = await safeJson(tokenRes);
  if (!tokenData || !tokenData.access_token) {
    const detail = (tokenData && (tokenData.error_description || tokenData.error)) || `HTTP ${tokenRes.status}`;
    return new Response(`GitHub sign-in failed: ${detail}`, { status: 400 });
  }

  const userRes = await fetch(`${API}/user`, { headers: ghHeaders(tokenData.access_token) });
  const userData = await safeJson(userRes);
  if (!userData || !userData.login) {
    return new Response("GitHub sign-in failed: could not read profile.", { status: 400 });
  }

  const session = await encryptSession(env, { token: tokenData.access_token, username: userData.login });
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, session, { maxAge: 60 * 60 * 24 * 30 }));
  headers.append("Set-Cookie", cookieHeader(STATE_COOKIE, "", { maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}

export async function handleLogout(request) {
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}

export async function handleMe(request, env) {
  const session = await getSession(request, env);
  return Response.json(session ? { connected: true, username: session.username } : { connected: false });
}

export async function handleGistCreate(request, env) {
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

export async function handleGistUpdate(request, env, id) {
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

export async function handleGistGet(request, env, id) {
  const session = await getSession(request, env);
  const headers = session ? ghHeaders(session.token) : { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT };
  const res = await fetch(`${API}/gists/${id}`, { headers });
  return proxyJson(res);
}

async function getSession(request, env) {
  const cookie = getCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  return decryptSession(env, cookie);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

async function proxyJson(res) {
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (err) {
    return null;
  }
}
