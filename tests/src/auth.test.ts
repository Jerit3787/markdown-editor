import { describe, it, expect, afterEach, vi } from "vitest";
import { encryptSession, decryptSession, cookieHeader, getCookie, signAnonToken, verifyAnonToken, encryptJSON, decryptJSON } from "../../src/auth";
import type { Env } from "../../src/env";

const fakeEnv = { SESSION_SECRET: "test-secret-key-not-real" } as unknown as Env;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe("session round trip", () => {
  it("decrypts a session it just encrypted", async () => {
    const value = await encryptSession(fakeEnv, { token: "gh-token", username: "alice" });
    const session = await decryptSession(fakeEnv, value);
    expect(session?.token).toBe("gh-token");
    expect(session?.username).toBe("alice");
  });

  it("rejects a session encrypted under a different secret", async () => {
    const value = await encryptSession({ SESSION_SECRET: "other-secret" } as unknown as Env, { token: "gh-token", username: "alice" });
    expect(await decryptSession(fakeEnv, value)).toBeNull();
  });

  it("rejects a malformed value", async () => {
    expect(await decryptSession(fakeEnv, "not-a-session")).toBeNull();
  });
});

// The cookie is a bearer credential — a copied value would live forever if
// only the browser's Max-Age bounded it. See auth.ts's own comment.
describe("session expiry", () => {
  it("stamps an expiry inside the ciphertext", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const value = await encryptSession(fakeEnv, { token: "gh-token", username: "alice" });
    const session = await decryptSession(fakeEnv, value);
    expect(session?.exp).toBe(Date.now() + THIRTY_DAYS_MS);
  });

  it("refuses a session replayed after its expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const value = await encryptSession(fakeEnv, { token: "gh-token", username: "alice" });

    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + THIRTY_DAYS_MS + 1);

    expect(await decryptSession(fakeEnv, value)).toBeNull();
  });

  it("still accepts it one moment before that", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const value = await encryptSession(fakeEnv, { token: "gh-token", username: "alice" });

    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + THIRTY_DAYS_MS - 1);

    expect(await decryptSession(fakeEnv, value)).not.toBeNull();
  });

  it("treats a session with no expiry field as expired rather than as unlimited", async () => {
    // Hand-built the way pre-expiry sessions were: the same AES-GCM
    // envelope, but a payload with no `exp` at all.
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fakeEnv.SESSION_SECRET));
    const key = await crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify({ token: "gh-token", username: "alice" })),
    );
    const b64url = (buf: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    expect(await decryptSession(fakeEnv, `${b64url(iv.buffer)}.${b64url(ciphertext)}`)).toBeNull();
  });
});

describe("cookieHeader", () => {
  it("marks the session cookie Secure, HttpOnly and SameSite=Lax", () => {
    const header = cookieHeader("mde_gh_session", "value", { maxAge: 60 });
    expect(header).toContain("; Secure");
    expect(header).toContain("; HttpOnly");
    expect(header).toContain("; SameSite=Lax");
    expect(header).toContain("; Max-Age=60");
  });

  it("round-trips a value that needs percent-encoding", () => {
    const header = cookieHeader("mde_gh_session", "a b;c", {});
    const request = new Request("https://example.com", { headers: { Cookie: header.split(";")[0]! } });
    expect(getCookie(request, "mde_gh_session")).toBe("a b;c");
  });
});

describe("anon token round trip", () => {
  it("verifies a token it just signed", async () => {
    const t = await signAnonToken(fakeEnv, { anonId: "anon:abc123", anonName: "Swift Otter" });
    expect(await verifyAnonToken(fakeEnv, t)).toEqual({ anonId: "anon:abc123", anonName: "Swift Otter" });
  });

  it("rejects a token signed under a different secret", async () => {
    const t = await signAnonToken({ SESSION_SECRET: "other" } as unknown as Env, { anonId: "anon:abc123", anonName: "Swift Otter" });
    expect(await verifyAnonToken(fakeEnv, t)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const t = await signAnonToken(fakeEnv, { anonId: "anon:abc123", anonName: "Swift Otter" });
    const [, sig] = t.split(".");
    const forgedBody = btoa(JSON.stringify({ anonId: "anon:evil", anonName: "x", iat: Date.now() }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyAnonToken(fakeEnv, `${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects a malformed value", async () => {
    expect(await verifyAnonToken(fakeEnv, "nope")).toBeNull();
  });

  it("rejects a token older than 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = await signAnonToken(fakeEnv, { anonId: "anon:abc123", anonName: "Swift Otter" });
    vi.setSystemTime(new Date("2026-02-05T00:00:00Z")); // +35 days
    expect(await verifyAnonToken(fakeEnv, t)).toBeNull();
    vi.useRealTimers();
  });

  it("rejects a payload whose anonId lacks the anon: prefix", async () => {
    const t = await signAnonToken(fakeEnv, { anonId: "danishhakim", anonName: "x" });
    expect(await verifyAnonToken(fakeEnv, t)).toBeNull();
  });
});

describe("encryptJSON / decryptJSON", () => {
  it("round-trips an arbitrary object and stamps an exp", async () => {
    const token = await encryptJSON(fakeEnv, { refreshToken: "r", accessToken: "a", accessTokenExp: 123 });
    const back = await decryptJSON<{ refreshToken: string; accessToken: string; accessTokenExp: number }>(fakeEnv, token);
    expect(back).toMatchObject({ refreshToken: "r", accessToken: "a", accessTokenExp: 123 });
    expect(typeof back!.exp).toBe("number");
    expect(back!.exp).toBeGreaterThan(Date.now());
  });

  it("returns null for a tampered / malformed value", async () => {
    expect(await decryptJSON(fakeEnv, "not.a.token")).toBeNull();
    expect(await decryptJSON(fakeEnv, "")).toBeNull();
  });

  it("returns null once exp has passed", async () => {
    const token = await encryptJSON(fakeEnv, { x: 1 }, -1000); // already expired
    expect(await decryptJSON<{ x: number }>(fakeEnv, token)).toBeNull();
  });

  it("returns null under a different secret", async () => {
    const token = await encryptJSON({ SESSION_SECRET: "other-secret" } as unknown as Env, { x: 1 });
    expect(await decryptJSON(fakeEnv, token)).toBeNull();
  });
});
