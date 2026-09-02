import { describe, it, expect, afterEach, vi } from "vitest";
import { encryptSession, decryptSession, cookieHeader, getCookie } from "../../src/auth";
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
