import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  handleRepoList,
  handleRepoCreate,
  handleRepoTree,
  handleRepoBlob,
  handleRepoCommits,
  handleRepoFileAtRef,
  filterMarkdownEntries,
  handleRepoPush,
  computeNewTreeEntries,
} from "./github-repo";
import { encryptSession } from "./auth";
import type { Env } from "./env";
import { startFakeGithubServer, type FakeGithubServer } from "./test-support/fake-github-server";

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

  it("creates a repo with the requested visibility, without auto-initializing it", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ name: "notes", private: true, auto_init: false });
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

  it("returns an empty tree instead of an error when the branch has no commits yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://api.github.com/repos/alice/notes/git/refs/heads/main") {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoTree(req, fakeEnv, "alice", "notes", "main");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ commitSha: null, treeSha: null, tree: [] });
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

describe("handleRepoCommits", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main");
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1);
    expect(res.status).toBe(401);
  });

  it("constructs the correct upstream URL with sha, page, and a fixed per_page=30", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/commits?sha=main&page=2&per_page=30");
        return new Response(JSON.stringify([{ sha: "abc123", commit: { message: "Fix bug", author: { name: "Alice", date: "2026-08-01T00:00:00Z" } } }]), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main&page=2", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 2);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sha: string }[];
    expect(data[0]!.sha).toBe("abc123");
  });

  it("proxies a non-200 upstream response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=missing-branch", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "missing-branch", 1);
    expect(res.status).toBe(404);
  });

  it("includes a path filter in the upstream URL when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/commits?sha=main&page=1&per_page=30&path=Notes.md");
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main&path=Notes.md", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1, "Notes.md");
    expect(res.status).toBe(200);
  });

  it("omits the path filter when not provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/commits?sha=main&page=1&per_page=30");
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/commits?branch=main", { headers: { Cookie: cookie } });
    const res = await handleRepoCommits(req, fakeEnv, "alice", "notes", "main", 1);
    expect(res.status).toBe(200);
  });
});

describe("handleRepoFileAtRef", () => {
  it("returns 401 when signed out", async () => {
    const req = new Request("https://example.com/api/repo/alice/notes/contents/Notes.md?ref=main");
    const res = await handleRepoFileAtRef(req, fakeEnv, "alice", "notes", "Notes.md", "main");
    expect(res.status).toBe(401);
  });

  it("constructs the correct upstream URL with per-segment encoding for a nested path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/alice/notes/contents/folder%20a/My%20Notes.md?ref=abc123");
        return new Response(JSON.stringify({ content: "aGVsbG8=", encoding: "base64" }), { status: 200 });
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/contents/folder%20a/My%20Notes.md?ref=abc123", { headers: { Cookie: cookie } });
    const res = await handleRepoFileAtRef(req, fakeEnv, "alice", "notes", "folder a/My Notes.md", "abc123");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { content: string };
    expect(data.content).toBe("aGVsbG8=");
  });

  it("proxies a non-200 upstream response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/contents/Missing.md?ref=main", { headers: { Cookie: cookie } });
    const res = await handleRepoFileAtRef(req, fakeEnv, "alice", "notes", "Missing.md", "main");
    expect(res.status).toBe(404);
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

  it("builds a first commit (no base_tree, no parents) and creates the ref via POST when baseTreeSha/parentCommitSha are both absent", async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method: init?.method || "GET", body });
        if (url.endsWith("/git/blobs")) return new Response(JSON.stringify({ sha: "blob-sha" }), { status: 201 });
        if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "new-tree-sha" }), { status: 201 });
        if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "new-commit-sha" }), { status: 201 });
        if (url.endsWith("/git/refs")) return new Response(JSON.stringify({ ref: "refs/heads/main", object: { sha: "new-commit-sha" } }), { status: 201 });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ branch: "main", blobs: [{ path: "a.md", contentBase64: "aGVsbG8=" }], deletePaths: [] }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(200);

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(treeCall.body.base_tree).toBeUndefined();
    const commitCall = calls.find((c) => c.url.endsWith("/git/commits"))!;
    expect(commitCall.body.parents).toBeUndefined();
    const refCall = calls.find((c) => c.url.endsWith("/git/refs"))!;
    expect(refCall.method).toBe("POST");
    expect(refCall.body).toEqual({ ref: "refs/heads/main", sha: "new-commit-sha" });
  });

  it("returns 400 when exactly one of baseTreeSha/parentCommitSha is present", async () => {
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ branch: "main", baseTreeSha: "base-tree", blobs: [], deletePaths: [] }),
    });
    const res = await handleRepoPush(req, fakeEnv, "alice", "notes");
    expect(res.status).toBe(400);
  });
});

describe("handleRepoPush against a real fake GitHub server", () => {
  let fakeServer: FakeGithubServer;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    fakeServer = await startFakeGithubServer();
    realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const rewritten = url.startsWith("https://api.github.com") ? url.replace("https://api.github.com", fakeServer.baseUrl) : url;
      return realFetch(rewritten, init);
    });
  });

  afterEach(async () => {
    await fakeServer.stop();
  });

  it("a push lands as a real commit that a later tree fetch reflects, alongside pre-existing content", async () => {
    fakeServer.seedRepo("alice", "notes", "main", [{ path: "existing.md", content: "old content" }]);
    const cookie = await sessionCookieHeader("tok", "alice");

    const treeReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const treeRes = await handleRepoTree(treeReq, fakeEnv, "alice", "notes", "main");
    const treeData = (await treeRes.json()) as { commitSha: string; treeSha: string };

    const pushReq = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        branch: "main",
        baseTreeSha: treeData.treeSha,
        parentCommitSha: treeData.commitSha,
        blobs: [{ path: "new.md", contentBase64: Buffer.from("new content").toString("base64") }],
        deletePaths: [],
      }),
    });
    const pushRes = await handleRepoPush(pushReq, fakeEnv, "alice", "notes");
    expect(pushRes.status).toBe(200);

    const followUpReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const followUpRes = await handleRepoTree(followUpReq, fakeEnv, "alice", "notes", "main");
    const followUpData = (await followUpRes.json()) as { tree: { path: string }[] };
    expect(followUpData.tree.map((e) => e.path).sort()).toEqual(["existing.md", "new.md"]);
  });

  it("pushes a genuine first commit to a brand-new (never-seeded) repo with no prior ref", async () => {
    const cookie = await sessionCookieHeader("tok", "alice");
    // No seedRepo call — getRepo() lazily creates empty state, matching a
    // freshly-created (no longer auto_init'd) real GitHub repo exactly.

    const treeReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const treeRes = await handleRepoTree(treeReq, fakeEnv, "alice", "notes", "main");
    expect(treeRes.status).toBe(200);
    const treeData = (await treeRes.json()) as { commitSha: string | null; treeSha: string | null; tree: unknown[] };
    expect(treeData).toEqual({ commitSha: null, treeSha: null, tree: [] });

    const pushReq = new Request("https://example.com/api/repo/alice/notes/push", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ branch: "main", blobs: [{ path: "notes.md", contentBase64: Buffer.from("hello").toString("base64") }], deletePaths: [] }),
    });
    const pushRes = await handleRepoPush(pushReq, fakeEnv, "alice", "notes");
    expect(pushRes.status).toBe(200);

    const followUpReq = new Request("https://example.com/api/repo/alice/notes/tree?branch=main", { headers: { Cookie: cookie } });
    const followUpRes = await handleRepoTree(followUpReq, fakeEnv, "alice", "notes", "main");
    const followUpData = (await followUpRes.json()) as { tree: { path: string }[] };
    expect(followUpData.tree.map((e) => e.path)).toEqual(["notes.md"]);
  });
});
