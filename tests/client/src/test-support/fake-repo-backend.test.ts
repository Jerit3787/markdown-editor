import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startFakeRepoBackend, type FakeRepoBackend } from "../../../../client/src/test-support/fake-repo-backend";

describe("fake-repo-backend", () => {
  let backend: FakeRepoBackend;

  beforeEach(async () => {
    backend = await startFakeRepoBackend();
  });

  afterEach(async () => {
    await backend.stop();
  });

  it("GET tree returns the seeded content in the shape pullFromRepo expects", async () => {
    backend.seedRepo("alice", "notes", "main", [{ path: "a.md", content: "hello" }]);
    const res = await fetch(`${backend.baseUrl}/api/repo/alice/notes/tree?branch=main`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { commitSha: string; treeSha: string; tree: { path: string }[] };
    expect(data.commitSha).toBeTruthy();
    expect(data.treeSha).toBeTruthy();
    expect(data.tree.map((e) => e.path)).toEqual(["a.md"]);
  });

  it("a push lands a real commit that a following tree fetch reflects", async () => {
    backend.seedRepo("alice", "notes", "main", []);
    const treeRes = await fetch(`${backend.baseUrl}/api/repo/alice/notes/tree?branch=main`);
    const treeData = (await treeRes.json()) as { commitSha: string; treeSha: string };

    const pushRes = await fetch(`${backend.baseUrl}/api/repo/alice/notes/push`, {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: treeData.treeSha,
        parentCommitSha: treeData.commitSha,
        blobs: [{ path: "new.md", contentBase64: Buffer.from("new content").toString("base64") }],
        deletePaths: [],
      }),
    });
    expect(pushRes.status).toBe(200);
    const pushData = (await pushRes.json()) as { commitSha: string; blobShas: Record<string, string> };
    expect(pushData.blobShas["new.md"]).toBeTruthy();

    const followUpRes = await fetch(`${backend.baseUrl}/api/repo/alice/notes/tree?branch=main`);
    const followUpData = (await followUpRes.json()) as { tree: { path: string }[] };
    expect(followUpData.tree.map((e) => e.path)).toEqual(["new.md"]);
  });
});
