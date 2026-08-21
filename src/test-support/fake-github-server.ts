import * as http from "node:http";
import * as crypto from "node:crypto";

export interface FakeTreeEntry {
  path: string;
  sha: string;
  type: "blob" | "tree";
}

interface RepoState {
  refs: Map<string, string>; // branch -> commit sha
  commits: Map<string, { tree: string; parents: string[] }>;
  trees: Map<string, FakeTreeEntry[]>; // tree sha -> flat entry list
  blobs: Map<string, string>; // blob sha -> base64 content
}

export interface FakeGithubServer {
  baseUrl: string;
  seedRepo(owner: string, repo: string, branch: string, files: { path: string; content: string }[]): void;
  stop(): Promise<void>;
}

function gitBlobSha(contentBytes: Buffer): string {
  const header = Buffer.from(`blob ${contentBytes.length}\0`, "utf-8");
  return crypto
    .createHash("sha1")
    .update(Buffer.concat([header, contentBytes]))
    .digest("hex");
}

// Buffer.prototype.toString(encoding) doesn't type-check on
// crypto.randomBytes()'s return value under this project's current
// @types/node + TypeScript combination (a generic-Buffer overload
// resolution issue, confirmed unrelated to any of this file's own
// logic) — sidestepped by converting bytes to hex manually instead.
function randomSha(): string {
  return Array.from(crypto.randomBytes(20), (b) => b.toString(16).padStart(2, "0")).join("");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startFakeGithubServer(): Promise<FakeGithubServer> {
  const repos = new Map<string, RepoState>();

  function getRepo(owner: string, repo: string): RepoState {
    const key = `${owner}/${repo}`;
    let state = repos.get(key);
    if (!state) {
      state = { refs: new Map(), commits: new Map(), trees: new Map(), blobs: new Map() };
      repos.set(key, state);
    }
    return state;
  }

  function resolveTreeEntries(state: RepoState, sha: string): FakeTreeEntry[] | undefined {
    const commit = state.commits.get(sha);
    if (commit) return state.trees.get(commit.tree);
    return state.trees.get(sha);
  }

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["repos", owner, repo, "git", kind, ...]

      try {
        if (parts[0] !== "repos" || parts.length < 5 || parts[3] !== "git") {
          sendJson(res, 404, { message: "not found" });
          return;
        }
        const owner = parts[1]!;
        const repo = parts[2]!;
        const kind = parts[4]!; // "refs" | "trees" | "blobs" | "commits"
        const state = getRepo(owner, repo);

        if (req.method === "GET" && kind === "refs" && parts[5] === "heads" && parts[6]) {
          const branch = parts.slice(6).join("/");
          const sha = state.refs.get(branch);
          if (!sha) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          sendJson(res, 200, { object: { sha } });
          return;
        }

        if (req.method === "GET" && kind === "trees" && parts[5]) {
          const entries = resolveTreeEntries(state, parts[5]);
          if (!entries) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          sendJson(res, 200, { sha: parts[5], tree: entries });
          return;
        }

        if (req.method === "GET" && kind === "blobs" && parts[5]) {
          const content = state.blobs.get(parts[5]);
          if (content === undefined) {
            sendJson(res, 404, { message: "Not Found" });
            return;
          }
          sendJson(res, 200, { sha: parts[5], content, encoding: "base64" });
          return;
        }

        if (req.method === "POST" && kind === "blobs") {
          const body = JSON.parse(await readBody(req)) as { content: string; encoding: string };
          const contentBytes = Buffer.from(body.content, "base64");
          const sha = gitBlobSha(contentBytes);
          state.blobs.set(sha, body.content);
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "POST" && kind === "trees") {
          const body = JSON.parse(await readBody(req)) as {
            base_tree?: string;
            tree: { path: string; mode: string; type: string; sha: string | null }[];
          };
          const baseEntries = body.base_tree ? resolveTreeEntries(state, body.base_tree) || [] : [];
          const byPath = new Map(baseEntries.map((e) => [e.path, e]));
          for (const entry of body.tree) {
            if (entry.sha === null) byPath.delete(entry.path);
            else byPath.set(entry.path, { path: entry.path, sha: entry.sha, type: "blob" });
          }
          const sha = randomSha();
          state.trees.set(sha, [...byPath.values()]);
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "POST" && kind === "commits") {
          const body = JSON.parse(await readBody(req)) as { message: string; tree: string; parents?: string[] };
          const sha = randomSha();
          state.commits.set(sha, { tree: body.tree, parents: body.parents || [] });
          sendJson(res, 201, { sha });
          return;
        }

        if (req.method === "POST" && kind === "refs" && !parts[5]) {
          // Creating a brand-new ref (a repo's very first commit on a
          // branch that doesn't exist yet) — distinct from the PATCH
          // case below, which updates an existing ref.
          const body = JSON.parse(await readBody(req)) as { ref: string; sha: string };
          const branch = body.ref.replace(/^refs\/heads\//, "");
          state.refs.set(branch, body.sha);
          sendJson(res, 201, { ref: body.ref, object: { sha: body.sha } });
          return;
        }

        if (req.method === "PATCH" && kind === "refs" && parts[5] === "heads" && parts[6]) {
          const branch = parts.slice(6).join("/");
          const body = JSON.parse(await readBody(req)) as { sha: string; force?: boolean };
          const currentSha = state.refs.get(branch);
          const newCommit = state.commits.get(body.sha);
          const isFastForward = !currentSha || (!!newCommit && newCommit.parents[0] === currentSha);
          if (!body.force && !isFastForward) {
            sendJson(res, 422, { message: "Update is not a fast forward" });
            return;
          }
          state.refs.set(branch, body.sha);
          sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } });
          return;
        }

        sendJson(res, 404, { message: "not found" });
      } catch (err) {
        sendJson(res, 500, { message: (err as Error).message });
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seedRepo(owner, repo, branch, files) {
          const state = getRepo(owner, repo);
          const entries: FakeTreeEntry[] = files.map((f) => {
            const contentBytes = Buffer.from(f.content, "utf-8");
            const sha = gitBlobSha(contentBytes);
            state.blobs.set(sha, contentBytes.toString("base64"));
            return { path: f.path, sha, type: "blob" };
          });
          const treeSha = randomSha();
          state.trees.set(treeSha, entries);
          const commitSha = randomSha();
          state.commits.set(commitSha, { tree: treeSha, parents: [] });
          state.refs.set(branch, commitSha);
        },
        stop() {
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
