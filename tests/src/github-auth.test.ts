import { describe, it, expect, vi, afterEach } from "vitest";
import { handleLogin, handleMe, handleCallback, handleLogout, handleGistCreate, handleGistUpdate, handleGistList, handleGistGet } from "../../src/github-auth";
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

  it("AUTH-04: sets a short-lived state cookie whose value is echoed in the authorize URL's state param", async () => {
    const res = await handleLogin(new Request("https://example.com/api/auth/github/login"), fakeEnv);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/mde_oauth_state=[^;]+/);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).toMatch(/HttpOnly/);
    const stateInCookie = setCookie.match(/mde_oauth_state=([^;]+)/)![1];
    const stateInUrl = new URL(res.headers.get("Location")!).searchParams.get("state");
    expect(stateInUrl).toBe(stateInCookie);
  });
});

describe("handleCallback happy path (AUTH-05)", () => {
  const oauthEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "secret" } as unknown as Env;

  it("verifies state, exchanges the code, sets the session cookie, and renders the success popup", async () => {
    const fetchMock = vi
      .fn()
      // 1st call: token exchange
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "gho_test" }), { status: 200 }))
      // 2nd call: GET /user
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "alice" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("https://example.com/api/auth/github/callback?code=abc&state=s1", { headers: { Cookie: "mde_oauth_state=s1" } });
    const res = await handleCallback(req, oauthEnv);

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => /^mde_gh_session=[^;]+/.test(c) && /Max-Age=2592000/.test(c))).toBe(true);
    expect(cookies.some((c) => /^mde_oauth_state=;?/.test(c) && /Max-Age=0/.test(c))).toBe(true);
    const html = await res.text();
    expect(html).toContain('"ok":true');
  });

  it("rejects a mismatched state without touching GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("https://example.com/api/auth/github/callback?code=abc&state=evil", { headers: { Cookie: "mde_oauth_state=s1" } });
    const res = await handleCallback(req, oauthEnv);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await res.text()).toContain("Invalid state.");
  });
});

describe("handleMe token-verification (AUTH-07)", () => {
  it("treats a 401 from GitHub's /user as a revoked token — signs the user out and clears the cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad credentials", { status: 401 })),
    );
    const req = new Request("https://example.com/api/auth/github/me", { headers: { Cookie: await sessionCookieHeader("stale", "alice") } });
    const res = await handleMe(req, fakeEnv);
    expect((await res.json()).connected).toBe(false);
    expect(res.headers.get("Set-Cookie")).toMatch(/mde_gh_session=;?.*Max-Age=0/);
  });

  it("trusts the local session when GitHub is simply unreachable (fetch throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const req = new Request("https://example.com/api/auth/github/me", { headers: { Cookie: await sessionCookieHeader("tok", "alice") } });
    const res = await handleMe(req, fakeEnv);
    const data = (await res.json()) as { connected: boolean; username?: string };
    expect(data.connected).toBe(true);
    expect(data.username).toBe("alice");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("handleLogout (AUTH-08)", () => {
  const oauthEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "secret" } as unknown as Env;

  it("clears the session cookie and returns 200 for a POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const req = new Request("https://example.com/api/auth/github/logout", { method: "POST", headers: { Cookie: await sessionCookieHeader("tok", "alice") } });
    const res = await handleLogout(req, oauthEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/mde_gh_session=;?.*Max-Age=0/);
  });

  it("still clears the session even when the upstream grant-revoke call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("github down");
      }),
    );
    const req = new Request("https://example.com/api/auth/github/logout", { method: "POST", headers: { Cookie: await sessionCookieHeader("tok", "alice") } });
    const res = await handleLogout(req, oauthEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
  });

  it("redirects to / for a GET", async () => {
    const req = new Request("https://example.com/api/auth/github/logout");
    const res = await handleLogout(req, oauthEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });
});

describe("Gist proxy handlers (GIST-01/02/03)", () => {
  async function signedInReq(url: string, init?: RequestInit): Promise<Request> {
    return new Request(url, { ...init, headers: { ...(init?.headers ?? {}), Cookie: await sessionCookieHeader("gho_tok", "alice") } });
  }

  it("all four reject with 401 when there is no session", async () => {
    const noCookie = () => new Request("https://example.com/api/gist");
    expect((await handleGistCreate(noCookie(), fakeEnv)).status).toBe(401);
    expect((await handleGistUpdate(noCookie(), fakeEnv, "g1")).status).toBe(401);
    expect((await handleGistList(noCookie(), fakeEnv)).status).toBe(401);
    // handleGistGet is allowed anonymously (public gists) — not asserted here
  });

  it("GIST-01: create forwards the request body (Public/Secret choice included) to POST /gists and proxies the result", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "new-gist", html_url: "x" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const req = await signedInReq("https://example.com/api/gist", { method: "POST", body: JSON.stringify({ public: false, files: { "a.md": { content: "hi" } } }) });
    const res = await handleGistCreate(req, fakeEnv);
    expect(res.status).toBe(201);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/gists");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toMatchObject({ public: false });
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer gho_tok");
  });

  it("GIST-02: update PATCHes /gists/:id with the forwarded body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "g1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const req = await signedInReq("https://example.com/api/gist/g1", { method: "PATCH", body: JSON.stringify({ files: { "notes.md": { content: "updated" } } }) });
    const res = await handleGistUpdate(req, fakeEnv, "g1");
    expect(res.status).toBe(200);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/gists/g1");
    expect(opts.method).toBe("PATCH");
  });

  it("GIST-03: list hits /gists?per_page=100; get hits /gists/:id", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleGistList(await signedInReq("https://example.com/api/gist"), fakeEnv);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.github.com/gists?per_page=100");

    fetchMock.mockClear();
    await handleGistGet(new Request("https://example.com/api/gist/abc"), fakeEnv, "abc");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.github.com/gists/abc");
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
