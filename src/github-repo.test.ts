import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleRepoList,
  handleRepoCreate,
  handleRepoTree,
  handleRepoBlob,
  filterMarkdownEntries,
  handleRepoPush,
  computeNewTreeEntries,
} from "./github-repo";
import { encryptSession } from "./auth";
import type { Env } from "./env";

const fakeEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!" } as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sessionCookieHeader(token: string, username: string): Promise<string> {
  const session = await encryptSession(fakeEnv, { token, username });
  return `mde_gh_session=${session}`;
}

describe("handleRepoList", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/list");
    const res = await handleRepoList(req, fakeEnv);
    expect(res.status).toBe(401);
  });

  it("proxies the user's repos when signed in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ full_name: "alice/notes", private: true, default_branch: "main" }]), { status: 200 }))
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/list", { headers: { Cookie: cookie } });
    const res = await handleRepoList(req, fakeEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([{ full_name: "alice/notes", private: true, default_branch: "main" }]);
  });
});

describe("handleRepoCreate", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/create", { method: "POST", body: JSON.stringify({ name: "notes" }) });
    const res = await handleRepoCreate(req, fakeEnv);
    expect(res.status).toBe(401);
  });

  it("creates a repo with the requested visibility", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ name: "notes", private: true, auto_init: true });
      return new Response(JSON.stringify({ full_name: "alice/notes", private: true, default_branch: "main" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/create", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ name: "notes", private: true }),
    });
    const res = await handleRepoCreate(req, fakeEnv);
    expect(res.status).toBe(201);
  });
});

describe("filterMarkdownEntries", () => {
  it("keeps only blob entries ending in .md, at any depth", () => {
    const entries = [
      { path: "README.md", sha: "a", type: "blob" as const },
      { path: "docs", sha: "b", type: "tree" as const },
      { path: "docs/notes.md", sha: "c", type: "blob" as const },
      { path: "assets/logo.png", sha: "d", type: "blob" as const },
      { path: "notes.MD", sha: "e", type: "blob" as const },
    ];
    expect(filterMarkdownEntries(entries)).toEqual([
      { path: "README.md", sha: "a", type: "blob" },
      { path: "docs/notes.md", sha: "c", type: "blob" },
      { path: "notes.MD", sha: "e", type: "blob" },
    ]);
  });
});

describe("handleRepoTree", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/tree?branch=main");
    const res = await handleRepoTree(req, fakeEnv, "alice", "notes", "main");
    expect(res.status).toBe(401);
  });

  it("resolves the branch to a commit sha first, then fetches that commit's tree", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "https://api.github.com/repos/alice/notes/git/refs/heads/main") {
          return new Response(JSON.stringify({ object: { sha: "commit-sha" } }), { status: 200 });
        }
        if (url === "https://api.github.com/repos/alice/notes/git/trees/commit-sha?recursive=1") {
          return new Response(JSON.stringify({ sha: "tree-sha", tree: [{ path: "a.md", sha: "x", type: "blob" }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoTree(req, fakeEnv, "alice", "notes", "main");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { commitSha: string; treeSha: string; tree: unknown };
    expect(data).toEqual({ commitSha: "commit-sha", treeSha: "tree-sha", tree: [{ path: "a.md", sha: "x", type: "blob" }] });
    expect(calls).toEqual([
      "https://api.github.com/repos/alice/notes/git/refs/heads/main",
      "https://api.github.com/repos/alice/notes/git/trees/commit-sha?recursive=1",
    ]);
  });
});

describe("handleRepoBlob", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/blob/x");
    const res = await handleRepoBlob(req, fakeEnv, "alice", "notes", "x");
    expect(res.status).toBe(401);
  });

  it("fetches a blob by sha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/git/blobs/x");
        return new Response(JSON.stringify({ sha: "x", content: "aGVsbG8=", encoding: "base64" }), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/blob/x", { headers: { Cookie: cookie } });
    const res = await handleRepoBlob(req, fakeEnv, "alice", "notes", "x");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { content: string };
    expect(data.content).toBe("aGVsbG8=");
  });
});

describe("computeNewTreeEntries", () => {
  it("adds new blob paths and updates existing ones", () => {
    const result = computeNewTreeEntries(
      [{ path: "a.md", sha: "old-a", type: "blob" }],
      [
        { path: "a.md", sha: "new-a" },
        { path: "b.md", sha: "new-b" },
      ],
      []
    );
    expect(result).toEqual([
      { path: "a.md", mode: "100644", type: "blob", sha: "new-a" },
      { path: "b.md", mode: "100644", type: "blob", sha: "new-b" },
    ]);
  });

  it("marks deleted paths with a null sha, leaves untouched paths out entirely", () => {
    const result = computeNewTreeEntries([{ path: "a.md", sha: "old-a", type: "blob" }], [], ["a.md"]);
    expect(result).toEqual([{ path: "a.md", mode: "100644", type: "blob", sha: null }]);
  });
});

describe("handleRepoPush", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/push", { method: "POST", body: "{}" });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(401);
  });

  it("builds one commit from blobs+tree+commit+ref calls, returns new blob shas", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        if (url.endsWith("/git/blobs")) {
          const body = JSON.parse(init!.body as string);
          return new Response(JSON.stringify({ sha: `sha-${body.content.slice(0, 4)}` }), { status: 201 });
        }
        if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "new-tree-sha" }), { status: 201 });
        if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "new-commit-sha" }), { status: 201 });
        if (url.includes("/git/refs/heads/")) return new Response(JSON.stringify({ ref: "refs/heads/main" }), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: "base-tree",
        parentCommitSha: "parent-commit-sha",
        blobs: [{ path: "a.md", contentBase64: "aGVsbG8=" }],
        deletePaths: [],
      }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { commitSha: string; blobShas: Record<string, string> };
    expect(data.commitSha).toBe("new-commit-sha");
    expect(data.blobShas["a.md"]).toBe("sha-aGVs");
    expect(calls).toEqual([
      "https://api.github.com/repos/alice/notes/git/blobs",
      "https://api.github.com/repos/alice/notes/git/trees",
      "https://api.github.com/repos/alice/notes/git/commits",
      "https://api.github.com/repos/alice/notes/git/refs/heads/main",
    ]);
  });

  it("returns 409 with conflict:true when the ref update is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/git/blobs")) return new Response(JSON.stringify({ sha: "s" }), { status: 201 });
        if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "t" }), { status: 201 });
        if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "c" }), { status: 201 });
        return new Response(JSON.stringify({ message: "Update is not a fast forward" }), { status: 422 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: "base-tree",
        parentCommitSha: "parent-commit-sha",
        blobs: [{ path: "a.md", contentBase64: "aGk=" }],
        deletePaths: [],
      }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(409);
    const data = (await res.json()) as { conflict: boolean };
    expect(data.conflict).toBe(true);
  });
});
