import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGoogleConnect } from "../../src/google-auth";
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
