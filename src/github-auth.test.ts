import { describe, it, expect, vi, afterEach } from "vitest";
import { handleMe } from "./github-auth";
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

describe("handleMe", () => {
  it("reports granted scopes from GitHub's X-OAuth-Scopes header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ login: "alice" }), { status: 200, headers: { "X-OAuth-Scopes": "repo, gist" } })),
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/auth/github/me", { headers: { Cookie: cookie } });
    const res = await handleMe(req, fakeEnv);
    const data = (await res.json()) as { connected: boolean; username?: string; scopes: string[] };
    expect(data.connected).toBe(true);
    expect(data.scopes).toEqual(["repo", "gist"]);
  });

  it("reports an empty scopes array when the header is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ login: "alice" }), { status: 200 })),
    );
    const cookie = await sessionCookieHeader("tok", "alice");
    const req = new Request("https://example.com/api/auth/github/me", { headers: { Cookie: cookie } });
    const res = await handleMe(req, fakeEnv);
    const data = (await res.json()) as { connected: boolean; username?: string; scopes: string[] };
    expect(data.scopes).toEqual([]);
  });

  it("reports an empty scopes array when signed out", async () => {
    const req = new Request("https://example.com/api/auth/github/me");
    const res = await handleMe(req, fakeEnv);
    const data = (await res.json()) as { connected: boolean; username?: string; scopes: string[] };
    expect(data.connected).toBe(false);
    expect(data.scopes).toEqual([]);
  });
});
