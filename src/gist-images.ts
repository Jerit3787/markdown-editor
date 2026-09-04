// Publishing an image to a gist through the REST API (files[name].content)
// can't produce a real binary file — that field is a JSON string, so a
// base64-encoded image would be stored as literal base64 *text* named
// "photo.png", which nothing can render as an image. A gist's files live
// in a real git repo (gist.github.com/<id>.git) though, and git's protocol
// carries true binary blobs — so this pushes the image as an actual
// tracked file via git's smart-HTTP protocol (through isomorphic-git,
// since Workers has no git binary or filesystem to shell out to), and the
// caller gets back a real gist.githubusercontent.com/.../raw/<file> URL
// that GitHub can actually render.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import { MemoryFS } from "./memory-fs.js";
import type { Env } from "./env";

const USER_AGENT = "markdown-editor-app (+https://editor.danplace.tech)";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Gist filenames are flat (no directories) and GitHub itself sanitizes
// most punctuation in them already — this just guards the git side of
// that (a slash would be read as a path separator by the tree-writing
// code below, silently nesting the file instead of naming it literally).
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\\/]+/g, "_")
      .replace(/[^\w.-]/g, "_")
      .slice(0, 200) || "image"
  );
}

export async function handleGistImageUpload(request: Request, env: Env, gistId: string): Promise<Response> {
  const cookie = getCookie(request, SESSION_COOKIE);
  const session = cookie ? await decryptSession(env, cookie) : null;
  if (!session) return new Response("Sign in with GitHub first.", { status: 401 });

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch (err: any) {
    return new Response(`Couldn't read the request body: ${err.message || "unknown error"}.`, { status: 400 });
  }

  let body: { filename?: unknown; contentBase64?: unknown };
  try {
    body = JSON.parse(bodyText);
  } catch (err: any) {
    // A diagnostic-only detail, not a stable API contract: this endpoint
    // has surfaced an unexplained 400 in production with no visibility
    // into which of its checks tripped (only the status code reaches the
    // Worker's own logs), so every 400 branch here reports specifics —
    // length/prefix only, never the full payload, to stay clear of
    // logging actual image bytes.
    return new Response(`Invalid JSON (length ${bodyText.length}, starts with ${JSON.stringify(bodyText.slice(0, 40))}): ${err.message || "unknown error"}.`, {
      status: 400,
    });
  }

  const rawFilename = body.filename;
  const rawContentBase64 = body.contentBase64;
  const filename = typeof rawFilename === "string" ? sanitizeFilename(rawFilename) : "";
  const contentBase64 = typeof rawContentBase64 === "string" ? rawContentBase64 : "";
  if (!filename || !contentBase64) {
    return new Response(
      `filename and contentBase64 are required (filename: ${JSON.stringify(rawFilename)}, contentBase64 type: ${typeof rawContentBase64}, length: ${
        typeof rawContentBase64 === "string" ? rawContentBase64.length : "n/a"
      }).`,
      { status: 400 },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(contentBase64);
  } catch (err: any) {
    return new Response(
      `Invalid base64 content (length ${contentBase64.length}, starts with ${JSON.stringify(contentBase64.slice(0, 20))}): ${err.message || "unknown error"}.`,
      { status: 400 },
    );
  }

  try {
    const url = await pushImageToGist(gistId, filename, bytes, session.username, session.token);
    return Response.json({ url });
  } catch (err: any) {
    return new Response(`Couldn't push the image to the gist: ${err.message || "unknown error"}`, { status: 502 });
  }
}

async function pushImageToGist(gistId: string, filename: string, bytes: Uint8Array, username: string, token: string): Promise<string> {
  const remoteUrl = `https://gist.github.com/${gistId}.git`;
  const dir = "/repo";
  const fs = new MemoryFS();
  // GitHub accepts the OAuth token as the password for git-over-HTTPS,
  // same "gist" scope this app already requests for the REST API — no
  // extra authorization step needed.
  const onAuth = () => ({ username, password: token });

  await git.clone({
    fs,
    http,
    dir,
    url: remoteUrl,
    singleBranch: true,
    depth: 1,
    onAuth,
    headers: { "User-Agent": USER_AGENT },
  });

  await fs.promises.writeFile(`${dir}/${filename}`, bytes);
  await git.add({ fs, dir, filepath: filename });
  await git.commit({
    fs,
    dir,
    message: `Add ${filename}`,
    author: { name: username, email: `${username}@users.noreply.github.com` },
  });

  const pushResult = await git.push({ fs, http, dir, url: remoteUrl, onAuth, headers: { "User-Agent": USER_AGENT } });
  const refUpdate = pushResult.refs && Object.values(pushResult.refs)[0];
  if (refUpdate && refUpdate.error) {
    throw new Error(refUpdate.error);
  }

  // /raw/<filename> without a ref segment always resolves to the latest
  // version — no need to know the gist's default branch name (always
  // "master" for gists specifically, but this sidesteps relying on that).
  return `https://gist.githubusercontent.com/${username}/${gistId}/raw/${encodeURIComponent(filename)}`;
}
