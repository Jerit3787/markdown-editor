import { describe, it, expect, vi, afterEach } from "vitest";
import { handleLogin, handleMe, handleCallback } from "../../src/github-auth";
import { encryptSession } from "../../src/auth";
import type { Env } from "../../src/env";

const fakeEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!", GITHUB_CLIENT_ID: "fake-client-id" } as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sessionCookieHeader(token: string, username: string): Promise<string> {
  const session = await encryptSession(fakeEnv, { token, username });
  return `mde_gh_session=${session}`;
}

describe("handleLogin", () => {
  it("requests both repo and gist scopes — dropping either breaks repo-sync or Gist publish for anyone who (re)authorizes", async () => {
    const req = new Request("https://example.com/api/auth/github/login");
    const res = await handleLogin(req, fakeEnv);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("scope")?.split(" ").sort()).toEqual(["gist", "repo"]);
  });
});

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

// The popup page inlines its postMessage payload into a <script> block on
// the app's own origin. JSON.stringify escapes quotes and backslashes but
// not "<", so an upstream message containing "</script>" would close that
// block early and land as live markup — see popupHtml's own comment.
describe("handleCallback popup page", () => {
  const oauthEnv = { ...fakeEnv, GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "secret" } as unknown as Env;

  function callbackRequest(): Request {
    return new Request("https://example.com/api/auth/github/callback?code=abc&state=s1", {
      headers: { Cookie: "mde_oauth_state=s1" },
    });
  }

  it("escapes tag-boundary characters in an upstream error before inlining it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error_description: "</script><script>alert(1)</script>" }), { status: 200 })),
    );

    const res = await handleCallback(callbackRequest(), oauthEnv);
    const html = await res.text();

    // Only the page's own single <script> tag survives; the payload's
    // angle brackets are \u-escaped, and the human-readable line below it
    // is HTML-escaped by escapeHtml.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("still delivers a benign message intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 })),
    );

    const res = await handleCallback(callbackRequest(), oauthEnv);
    const html = await res.text();

    expect(html).toContain('"message":"bad_verification_code"');
  });
});
