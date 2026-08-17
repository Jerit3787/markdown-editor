import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startFakeGithubServer, type FakeGithubServer } from "./fake-github-server";

describe("fake-github-server", () => {
  let server: FakeGithubServer;

  beforeEach(async () => {
    server = await startFakeGithubServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("seedRepo makes the seeded file visible via ref+tree lookup", async () => {
    server.seedRepo("alice", "notes", "main", [{ path: "a.md", content: "hello" }]);
    const refRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`);
    expect(refRes.status).toBe(200);
    const refData = (await refRes.json()) as { object: { sha: string } };
    const treeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees/${refData.object.sha}?recursive=1`);
    expect(treeRes.status).toBe(200);
    const treeData = (await treeRes.json()) as { tree: { path: string }[] };
    expect(treeData.tree.map((e) => e.path)).toEqual(["a.md"]);
  });

  it("computes the real git blob sha1 for pushed content", async () => {
    const res = await fetch(`${server.baseUrl}/repos/alice/notes/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: "", encoding: "base64" }),
    });
    const data = (await res.json()) as { sha: string };
    // git's blob sha of the empty string, per `git hash-object -t blob --stdin < /dev/null`
    // (same reference value already used in client/src/repo-sync.test.ts)
    expect(data.sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("a full blob-tree-commit-ref push sequence updates what a later tree fetch returns, alongside pre-existing content", async () => {
    server.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "old" }]);
    const refRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`);
    const { object } = (await refRes.json()) as { object: { sha: string } };
    const parentCommitSha = object.sha;
    const treeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees/${parentCommitSha}?recursive=1`);
    const { sha: baseTreeSha } = (await treeRes.json()) as { sha: string };

    const blobRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: Buffer.from("new content").toString("base64"), encoding: "base64" }),
    });
    const { sha: blobSha } = (await blobRes.json()) as { sha: string };

    const newTreeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree: [{ path: "new.md", mode: "100644", type: "blob", sha: blobSha }] }),
    });
    const { sha: newTreeSha } = (await newTreeRes.json()) as { sha: string };

    const commitRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: "add new.md", tree: newTreeSha, parents: [parentCommitSha] }),
    });
    const { sha: newCommitSha } = (await commitRes.json()) as { sha: string };

    const refUpdateRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommitSha, force: false }),
    });
    expect(refUpdateRes.status).toBe(200);

    const finalTreeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees/${newCommitSha}?recursive=1`);
    const finalTree = (await finalTreeRes.json()) as { tree: { path: string }[] };
    expect(finalTree.tree.map((e) => e.path).sort()).toEqual(["existing.md", "new.md"]);
  });

  it("rejects a non-fast-forward ref update", async () => {
    server.seedRepo("alice", "notes", "main", [{ path: "a.md", content: "x" }]);
    const emptyTreeRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/trees`, {
      method: "POST",
      body: JSON.stringify({ tree: [] }),
    });
    const { sha: emptyTreeSha } = (await emptyTreeRes.json()) as { sha: string };
    const orphanCommitRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: "orphan", tree: emptyTreeSha, parents: [] }),
    });
    const { sha: orphanCommitSha } = (await orphanCommitRes.json()) as { sha: string };

    const refUpdateRes = await fetch(`${server.baseUrl}/repos/alice/notes/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: orphanCommitSha, force: false }),
    });
    expect(refUpdateRes.status).not.toBe(200);
  });
});
