import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGistImageUpload } from "../../src/gist-images";
import { encryptSession, SESSION_COOKIE } from "../../src/auth";
import type { Env } from "../../src/env";

const fakeEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!" } as unknown as Env;
// A real (tiny, 1x1 transparent) PNG, base64-encoded — realistic input
// shaped exactly like what the client actually sends, not a placeholder.
const REAL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sessionCookieHeader(): Promise<string> {
  const session = await encryptSession(fakeEnv, { token: "gh-token", username: "alice" });
  return `${SESSION_COOKIE}=${session}`;
}

function imageRequest(body: unknown, cookie: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return new Request("https://example.com/api/gist/abc123/image", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleGistImageUpload", () => {
  it("requires sign-in", async () => {
    const res = await handleGistImageUpload(imageRequest({ filename: "a.png", contentBase64: REAL_PNG_BASE64 }, null), fakeEnv, "abc123");
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON with diagnostic detail", async () => {
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest("{not json", cookie), fakeEnv, "abc123");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Invalid JSON");
    expect(text).toContain("{not json");
  });

  it("rejects a missing filename with diagnostic detail", async () => {
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest({ contentBase64: REAL_PNG_BASE64 }, cookie), fakeEnv, "abc123");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("filename and contentBase64 are required");
    expect(text).toContain("undefined");
  });

  it("rejects a missing contentBase64 with diagnostic detail", async () => {
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest({ filename: "a.png" }, cookie), fakeEnv, "abc123");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("filename and contentBase64 are required");
  });

  it("rejects invalid base64 content with diagnostic detail", async () => {
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest({ filename: "a.png", contentBase64: "not-valid-base64!!!" }, cookie), fakeEnv, "abc123");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Invalid base64 content");
  });

  // A well-formed request (real filename, real base64 image content —
  // exactly what the client sends for an ordinary pasted image) must pass
  // every validation check here and reach the actual git push attempt.
  // There's no real gist.github.com to push to in a test, so this stubs
  // fetch to fail fast and asserts the failure is a 502 from the push
  // itself, never one of the 400s above — pinning down that a normal
  // image never trips validation it shouldn't.
  it("passes validation for a normal image and only fails downstream at the git push", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable in test");
      }),
    );
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest({ filename: "screenshot.png", contentBase64: REAL_PNG_BASE64 }, cookie), fakeEnv, "abc123");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("Couldn't push the image to the gist");
  });
});
