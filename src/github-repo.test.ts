import { describe, it, expect, vi, afterEach } from "vitest";
import { handleRepoList, handleRepoCreate } from "./github-repo";
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
