import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGoogleConnect, handleGoogleCallback, getGoogleAccessToken } from "../../src/google-auth";
import { encryptJSON } from "../../src/auth";
import type { Env } from "../../src/env";

const env = {
  SESSION_SECRET: "test-secret-key-not-real",
  GOOGLE_CLIENT_ID: "gcid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "gcs",
  GOOGLE_API_KEY: "gak",
} as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe("handleGoogleConnect", () => {
  it("redirects to Google's authorize URL requesting exactly drive.file, offline access, and consent", async () => {
    const res = await handleGoogleConnect(new Request("https://app.example/api/auth/google/connect"), env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://app.example/api/auth/google/callback");
    const state = loc.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(10);
    expect(res.headers.get("Set-Cookie")).toContain(`mde_google_oauth_state=${state}`);
  });

  it("returns 503 when GOOGLE_CLIENT_ID is not configured", async () => {
    const res = await handleGoogleConnect(new Request("https://app.example/api/auth/google/connect"), { SESSION_SECRET: "x" } as unknown as Env);
    expect(res.status).toBe(503);
  });
});

function tokenRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("handleGoogleCallback", () => {
  it("exchanges the code and sets an encrypted session cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenRes({ access_token: "at1", refresh_token: "rt1", expires_in: 3600 })),
    );
    const req = new Request("https://app.example/api/auth/google/callback?code=c&state=s", {
      headers: { Cookie: "mde_google_oauth_state=s" },
    });
    const res = await handleGoogleCallback(req, env);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("mde_google_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(await res.text()).toContain("mde-google-auth");
  });

  it("fails the popup on a state mismatch, without calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("https://app.example/api/auth/google/callback?code=c&state=evil", {
      headers: { Cookie: "mde_google_oauth_state=s" },
    });
    const res = await handleGoogleCallback(req, env);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the popup when Google withholds a refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenRes({ access_token: "at1", expires_in: 3600 })),
    );
    const req = new Request("https://app.example/api/auth/google/callback?code=c&state=s", {
      headers: { Cookie: "mde_google_oauth_state=s" },
    });
    const res = await handleGoogleCallback(req, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/disconnect/i);
  });
});

describe("getGoogleAccessToken", () => {
  async function reqWithSession(session: object) {
    const cookie = await encryptJSON(env, session);
    return new Request("https://app.example/api/drive/x", { headers: { Cookie: `mde_google_session=${cookie}` } });
  }

  it("returns the stored token unchanged while it is still fresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const req = await reqWithSession({ refreshToken: "rt", accessToken: "at", accessTokenExp: Date.now() + 5 * 60_000 });
    const out = await getGoogleAccessToken(req, env);
    expect(out).toEqual({ token: "at" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and returns a Set-Cookie for the caller to thread", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenRes({ access_token: "at2", expires_in: 3600 })),
    );
    const req = await reqWithSession({ refreshToken: "rt", accessToken: "old", accessTokenExp: Date.now() - 1000 });
    const out = await getGoogleAccessToken(req, env);
    expect(out!.token).toBe("at2");
    expect(out!.setCookie).toContain("mde_google_session=");
  });

  it("returns null when the refresh token is rejected (revoked / idle)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenRes({ error: "invalid_grant" }, 400)),
    );
    const req = await reqWithSession({ refreshToken: "rt", accessToken: "old", accessTokenExp: Date.now() - 1000 });
    expect(await getGoogleAccessToken(req, env)).toBeNull();
  });

  it("returns null when there is no session cookie", async () => {
    expect(await getGoogleAccessToken(new Request("https://app.example/api/drive/x"), env)).toBeNull();
  });
});
