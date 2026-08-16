// GitHub repo-sync endpoints — parallel to the Gist ones in github-auth.ts,
// using the same encrypted-cookie session. This file duplicates
// getSession/ghHeaders/safeJson rather than importing github-auth.ts's
// (unexported) copies, keeping the two integrations independently
// readable — they diverge in scope (repo vs gist) and will keep diverging
// as this file grows push/pull-specific logic github-auth.ts has no need for.
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import type { Env, SessionData } from "./env";

const API = "https://api.github.com";
const USER_AGENT = "markdown-editor-app (+https://editor.danplace.tech)";

export async function handleRepoList(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/user/repos?per_page=100&sort=updated`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}

export async function handleRepoCreate(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  let body: { name?: unknown; private?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return new Response("name is required.", { status: 400 });
  const isPrivate = body.private !== false; // defaults to private, matching the spec's "most people's real notes are private" reasoning
  const res = await fetch(`${API}/user/repos`, {
    method: "POST",
    headers: { ...ghHeaders(session.token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
  });
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
