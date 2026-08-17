import * as http from "node:http";
import { startFakeGithubServer, type FakeGithubServer } from "../../../src/test-support/fake-github-server";

export interface FakeRepoBackend {
  baseUrl: string;
  seedRepo(owner: string, repo: string, branch: string, files: { path: string; content: string }[]): void;
  stop(): Promise<void>;
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

// Duplicates the small amount of tree/blob/push proxy logic from
// src/github-repo.ts's handleRepoTree/handleRepoBlob/handleRepoPush,
// rather than importing them — a client file can never import anything
// that transitively needs the Env type (see this plan's Global
// Constraints). This mirrors github-repo.ts's own precedent of
// duplicating small integration-specific glue (its header comment
// explains it duplicates getSession/ghHeaders/safeJson from
// github-auth.ts for the same kind of independent-readability reason).
export async function startFakeRepoBackend(): Promise<FakeRepoBackend> {
  const github: FakeGithubServer = await startFakeGithubServer();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "repo", owner, repo, action, ...]

    try {
      if (parts[0] !== "api" || parts[1] !== "repo" || parts.length < 5) {
        sendJson(res, 404, { message: "not found" });
        return;
      }
      const owner = parts[2]!;
      const repo = parts[3]!;
      const action = parts[4]!;
      const base = `${github.baseUrl}/repos/${owner}/${repo}`;

      if (req.method === "GET" && action === "tree") {
        const branch = url.searchParams.get("branch") || "main";
        const refRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`);
        if (!refRes.ok) {
          sendJson(res, refRes.status, await refRes.json());
          return;
        }
        const refData = (await refRes.json()) as { object: { sha: string } };
        const commitSha = refData.object.sha;
        const treeRes = await fetch(`${base}/git/trees/${commitSha}?recursive=1`);
        const treeData = (await treeRes.json()) as { sha: string; tree: unknown };
        sendJson(res, 200, { commitSha, treeSha: treeData.sha, tree: treeData.tree });
        return;
      }

      if (req.method === "GET" && action === "blob" && parts[5]) {
        const blobRes = await fetch(`${base}/git/blobs/${parts[5]}`);
        sendJson(res, blobRes.status, await blobRes.json());
        return;
      }

      if (req.method === "POST" && action === "push") {
        const body = JSON.parse(await readBody(req)) as {
          branch: string;
          baseTreeSha: string;
          parentCommitSha: string;
          blobs: { path: string; contentBase64: string }[];
          deletePaths: string[];
        };

        const blobShas: Record<string, string> = {};
        for (const blob of body.blobs) {
          const blobRes = await fetch(`${base}/git/blobs`, {
            method: "POST",
            body: JSON.stringify({ content: blob.contentBase64, encoding: "base64" }),
          });
          const data = (await blobRes.json()) as { sha: string };
          blobShas[blob.path] = data.sha;
        }

        const treeEntries = [
          ...body.blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: blobShas[b.path]! })),
          ...body.deletePaths.map((path) => ({ path, mode: "100644", type: "blob", sha: null as string | null })),
        ];
        const treeRes = await fetch(`${base}/git/trees`, {
          method: "POST",
          body: JSON.stringify({ base_tree: body.baseTreeSha, tree: treeEntries }),
        });
        const treeData = (await treeRes.json()) as { sha: string };

        const commitRes = await fetch(`${base}/git/commits`, {
          method: "POST",
          body: JSON.stringify({ message: "Update from Markdown Editor", tree: treeData.sha, parents: [body.parentCommitSha] }),
        });
        const commitData = (await commitRes.json()) as { sha: string };

        const refRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(body.branch)}`, {
          method: "PATCH",
          body: JSON.stringify({ sha: commitData.sha, force: false }),
        });
        if (!refRes.ok) {
          sendJson(res, 409, { conflict: true, message: await refRes.text() });
          return;
        }

        sendJson(res, 200, { commitSha: commitData.sha, blobShas });
        return;
      }

      sendJson(res, 404, { message: "not found" });
    } catch (err) {
      sendJson(res, 500, { message: (err as Error).message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seedRepo: github.seedRepo,
        stop: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          await github.stop();
        },
      });
    });
  });
}
