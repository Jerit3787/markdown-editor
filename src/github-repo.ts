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

// Anything interpolated into an api.github.com URL below has to be
// *validated*, not just encoded. The WHATWG URL parser resolves dot
// segments after interpolation, and it counts the percent-encoded spellings
// ("%2e%2e", ".%2e", ...) as dot segments too — so an owner of "%2e%2e" or
// a sha of "../../user" walks the request up out of
// /repos/{owner}/{repo}/ and turns these deliberately narrow proxy
// endpoints into a general-purpose GitHub API proxy carrying the user's own
// `repo`-scoped token. That token is the one thing this Worker never hands
// to the client (see auth.ts's header comment), so letting a same-origin
// script reach arbitrary API endpoints with it would defeat the whole
// point of proxying. encodeURIComponent is not a fix on its own: "." and
// ".." are unreserved characters, so it passes them through untouched.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const HEX_SHA = /^[0-9a-f]{4,64}$/i;

export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}

export function isSafeSha(value: string): boolean {
  return HEX_SHA.test(value);
}

// A repo-relative file path: real subdirectories are fine, dot segments and
// empty segments are not (see isSafeSegment's note on why encoding alone
// doesn't stop traversal). Backslashes are rejected too — harmless to
// GitHub, but they let a path read one way here and another on a Windows
// checkout.
export function isSafeRepoPath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

// Only guards the one place a branch reaches a URL *path*
// (git/refs/heads/{branch}); every other use is a query-string value or a
// JSON body field, neither of which is path-normalized. Git itself forbids
// ".." in a ref name, so nothing legitimate is lost.
export function isSafeBranch(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && !value.includes("..") && !value.includes("\\");
}

function invalidTarget(what: string): Response {
  return new Response(`Invalid ${what}.`, { status: 400 });
}

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
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
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
  const headers: HeadersInit = { "Content-Type": "application/json" };
  const link = res.headers.get("Link");
  if (link) headers["Link"] = link;
  return new Response(res.body, { status: res.status, headers });
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
//
// sha, when given, names an exact historical commit directly and skips
// the branch-ref resolution entirely — used by VersionHistory.svelte to
// look up a file's path as of an old commit (a file that's since been
// renamed doesn't live at its current repoPath in commits before the
// rename; contents/{currentPath}?ref={oldSha} 404s, and the only way to
// find where it actually was is to search that commit's own tree).
export async function handleRepoTree(request: Request, env: Env, owner: string, repo: string, branch: string, sha?: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) return invalidTarget("repository");
  if (sha !== undefined && !isSafeSha(sha)) return invalidTarget("sha");
  if (!sha && !isSafeBranch(branch)) return invalidTarget("branch");
  const headers = ghHeaders(session.token);
  let commitSha = sha;
  if (!commitSha) {
    const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { headers });
    if (refRes.status === 404) {
      // A freshly created repo (or any repo with no commits yet on this
      // branch) has no ref to resolve — this is a legitimate empty state,
      // not an error. handleRepoPush knows how to build a repo's very
      // first commit when it receives no baseTreeSha/parentCommitSha.
      return Response.json({ commitSha: null, treeSha: null, tree: [] });
    }
    if (!refRes.ok) return proxyJson(refRes);
    const refData = await safeJson<{ object: { sha: string } }>(refRes);
    if (!refData) return new Response("Failed to resolve branch: invalid response", { status: 502 });
    commitSha = refData.object.sha;
  }

  const treeRes = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`, { headers });
  if (!treeRes.ok) return proxyJson(treeRes);
  const treeData = await safeJson<{ sha: string; tree: TreeEntry[] }>(treeRes);
  if (!treeData) return new Response("Failed to fetch tree: invalid response", { status: 502 });

  return Response.json({ commitSha, treeSha: treeData.sha, tree: treeData.tree });
}

export async function handleRepoBlob(request: Request, env: Env, owner: string, repo: string, sha: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) return invalidTarget("repository");
  if (!isSafeSha(sha)) return invalidTarget("sha");
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}

export async function handleRepoCommits(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  branch: string,
  page: number,
  path?: string,
): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) return invalidTarget("repository");
  const pathParam = path ? `&path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&page=${page}&per_page=30${pathParam}`, {
    headers: ghHeaders(session.token),
  });
  return proxyJson(res);
}

export async function handleRepoFileAtRef(request: Request, env: Env, owner: string, repo: string, path: string, ref: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) return invalidTarget("repository");
  if (!isSafeRepoPath(path)) return invalidTarget("path");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, { headers: ghHeaders(session.token) });
  return proxyJson(res);
}

export function computeNewTreeEntries(
  baseTreeEntries: TreeEntry[],
  blobShas: { path: string; sha: string }[],
  deletePaths: string[],
): { path: string; mode: "100644"; type: "blob"; sha: string | null }[] {
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  for (const { path, sha } of blobShas) entries.push({ path, mode: "100644", type: "blob", sha });
  for (const path of deletePaths) entries.push({ path, mode: "100644", type: "blob", sha: null });
  return entries;
}

export async function handleRepoPush(request: Request, env: Env, owner: string, repo: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response("Not signed in", { status: 401 });
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) return invalidTarget("repository");

  let body: { branch?: unknown; baseTreeSha?: unknown; parentCommitSha?: unknown; blobs?: unknown; deletePaths?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const branch = typeof body.branch === "string" ? body.branch : "";
  // baseTreeSha (a *tree* sha) becomes the new tree's base_tree below;
  // parentCommitSha (a *commit* sha — the branch head's current commit,
  // distinct from its tree) becomes the new commit's parents[0]. Mixing
  // these up produces a commit whose parent doesn't match its own tree's
  // base, which the ref-update step below would then reject. Both empty
  // together means "this repo/branch has no commits yet" —
  // handleRepoTree returns them as null/empty in exactly that case (see
  // its own comment). One present without the other is a client bug,
  // not a legitimate empty-repo push, so it's still rejected below.
  const baseTreeSha = typeof body.baseTreeSha === "string" ? body.baseTreeSha : "";
  const parentCommitSha = typeof body.parentCommitSha === "string" ? body.parentCommitSha : "";
  const blobs = Array.isArray(body.blobs) ? (body.blobs as { path: string; contentBase64: string }[]) : [];
  const deletePaths = Array.isArray(body.deletePaths) ? (body.deletePaths as string[]) : [];
  const isFirstCommit = !baseTreeSha && !parentCommitSha;
  if (!branch || (!isFirstCommit && (!baseTreeSha || !parentCommitSha))) {
    return new Response("branch is required, and baseTreeSha/parentCommitSha must both be present or both absent.", { status: 400 });
  }
  if (!isSafeBranch(branch)) return invalidTarget("branch");
  if (!isFirstCommit && (!isSafeSha(baseTreeSha) || !isSafeSha(parentCommitSha))) return invalidTarget("sha");
  // These land in the tree API's JSON body rather than a URL, so they're
  // not a traversal risk against api.github.com itself — but a path that
  // climbs out of the repo root has no legitimate meaning here either, and
  // silently writing one is worse than rejecting it.
  for (const blob of blobs) {
    if (typeof blob?.path !== "string" || !isSafeRepoPath(blob.path)) return invalidTarget("blob path");
    if (typeof blob?.contentBase64 !== "string") return invalidTarget("blob content");
  }
  for (const path of deletePaths) {
    if (typeof path !== "string" || !isSafeRepoPath(path)) return invalidTarget("delete path");
  }

  const headers = { ...ghHeaders(session.token), "Content-Type": "application/json" };
  const base = `${API}/repos/${owner}/${repo}`;

  const blobShas: Record<string, string> = {};
  for (const blob of blobs) {
    const res = await fetch(`${base}/git/blobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: blob.contentBase64, encoding: "base64" }),
    });
    if (!res.ok) return new Response(`Failed to create blob for ${blob.path}: ${await res.text()}`, { status: 502 });
    const data = await safeJson<{ sha: string }>(res);
    if (!data) return new Response(`Failed to create blob for ${blob.path}: invalid response`, { status: 502 });
    blobShas[blob.path] = data.sha;
  }

  const treeEntries = computeNewTreeEntries(
    [],
    blobs.map((b) => ({ path: b.path, sha: blobShas[b.path]! })),
    deletePaths,
  );
  const treeBody: { tree: typeof treeEntries; base_tree?: string } = { tree: treeEntries };
  if (!isFirstCommit) treeBody.base_tree = baseTreeSha;
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify(treeBody),
  });
  if (!treeRes.ok) return new Response(`Failed to build tree: ${await treeRes.text()}`, { status: 502 });
  const treeData = await safeJson<{ sha: string }>(treeRes);
  if (!treeData) return new Response("Failed to build tree: invalid response", { status: 502 });

  const commitBody: { message: string; tree: string; parents?: string[] } = { message: "Update from Markdown Editor", tree: treeData.sha };
  if (!isFirstCommit) commitBody.parents = [parentCommitSha];
  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify(commitBody),
  });
  if (!commitRes.ok) return new Response(`Failed to create commit: ${await commitRes.text()}`, { status: 502 });
  const commitData = await safeJson<{ sha: string }>(commitRes);
  if (!commitData) return new Response("Failed to create commit: invalid response", { status: 502 });

  // A first commit has no ref yet to update — it has to be created, not
  // patched. Any later push against the same branch always has
  // isFirstCommit false (handleRepoTree found a real ref by then), so
  // this only ever runs once per branch.
  const refRes = isFirstCommit
    ? await fetch(`${base}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitData.sha }),
      })
    : await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sha: commitData.sha, force: false }),
      });
  if (!refRes.ok) {
    return Response.json({ conflict: true, message: await refRes.text() }, { status: 409 });
  }

  return Response.json({ commitSha: commitData.sha, blobShas });
}
