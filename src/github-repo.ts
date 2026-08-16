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

export interface TreeEntry {
  path: string;
  sha: string;
  type: "blob" | "tree";
}

export function filterMarkdownEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.filter((e) => e.type === "blob" && /\.md$/i.test(e.path));
}

// Resolves the branch to its current commit sha first, then fetches that
// exact commit's tree — rather than passing the branch name straight to
// the trees endpoint (which GitHub also accepts and resolves internally).
// The two-step version costs one extra request but means the response can
// hand back the commit sha too: the push endpoint below needs it (as
// parents[0] for the new commit) and has no other way to get it, since
// nothing else in this file resolves a branch to a commit.
export async function handleRepoTree(request: Request, env: Env, owner: string, repo: string, branch: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const headers = ghHeaders(session.token);
  const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { headers });
  if (!refRes.ok) return proxyJson(refRes);
  const refData = await safeJson<{ object: { sha: string } }>(refRes);
  if (!refData) return new Response("Failed to resolve branch: invalid response", { status: 502 });
  const commitSha = refData.object.sha;

  const treeRes = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`, { headers });
  if (!treeRes.ok) return proxyJson(treeRes);
  const treeData = await safeJson<{ sha: string; tree: TreeEntry[] }>(treeRes);
  if (!treeData) return new Response("Failed to fetch tree: invalid response", { status: 502 });

  return Response.json({ commitSha, treeSha: treeData.sha, tree: treeData.tree });
}

export async function handleRepoBlob(request: Request, env: Env, owner: string, repo: string, sha: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}
