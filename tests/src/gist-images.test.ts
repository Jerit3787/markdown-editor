import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGistImageUpload } from "../../src/gist-images";
import { encryptSession, SESSION_COOKIE } from "../../src/auth";
import type { Env } from "../../src/env";

// The real isomorphic-git smart-HTTP push has no lightweight test double
// (it would need a full git server speaking the pkt-line wire protocol) —
// but the app logic *around* the push is ours and worth pinning: the
// remote URL and raw-URL construction, the OAuth-token-as-git-password
// trick, the clone/add/commit/push call sequence, and the ref-error →
// failure mapping. These tests mock the isomorphic-git surface and assert
// that orchestration; the packfile wire format is isomorphic-git's own
// concern (and its own test suite's).
type PushResult = { ok: string[]; refs: Record<string, { ok?: boolean; error?: string }> };
const OK_PUSH: PushResult = { ok: ["refs/heads/main"], refs: { "refs/heads/main": { ok: true } } };
const gitMock = vi.hoisted(() => ({
  clone: vi.fn(async (_opts: Record<string, unknown>): Promise<void> => {}),
  add: vi.fn(async (_opts: Record<string, unknown>): Promise<void> => {}),
  commit: vi.fn(async (_opts: Record<string, unknown>): Promise<string> => "commit-sha"),
  push: vi.fn(async (_opts: Record<string, unknown>): Promise<{ ok: string[]; refs: Record<string, { ok?: boolean; error?: string }> }> => ({
    ok: ["refs/heads/main"],
    refs: { "refs/heads/main": { ok: true } },
  })),
}));
vi.mock("isomorphic-git", () => ({ default: gitMock }));
vi.mock("isomorphic-git/http/web", () => ({ default: {} }));

const fakeEnv = { SESSION_SECRET: "test-secret-at-least-32-bytes-long!!" } as unknown as Env;
// A real (tiny, 1x1 transparent) PNG, base64-encoded — realistic input
// shaped exactly like what the client actually sends, not a placeholder.
const REAL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(() => {
  vi.unstubAllGlobals();
  gitMock.clone.mockClear();
  gitMock.add.mockClear();
  gitMock.commit.mockClear();
  gitMock.push.mockClear();
  gitMock.push.mockResolvedValue(OK_PUSH);
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

  // GIST-05 — a well-formed request (real filename, real base64 image
  // content, exactly what the client sends for an ordinary pasted image)
  // passes every validation check above and drives the full git push:
  // clone the gist repo, write + add + commit the image, push, and hand
  // back a real raw URL. Asserts the app-owned orchestration around the
  // (mocked) isomorphic-git calls.
  it("clones, commits, and pushes the image, returning its raw gist URL", async () => {
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest({ filename: "my screenshot.png", contentBase64: REAL_PNG_BASE64 }, cookie), fakeEnv, "abc123");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      // filename sanitized (space → "_"), no ref segment (latest), username + gist id in the path
      url: "https://gist.githubusercontent.com/alice/abc123/raw/my_screenshot.png",
    });

    // Cloned the gist's own git repo, shallow + single-branch.
    expect(gitMock.clone).toHaveBeenCalledTimes(1);
    const cloneArgs = gitMock.clone.mock.calls[0]![0] as unknown as { url: string; singleBranch: boolean; depth: number; onAuth: () => unknown };
    expect(cloneArgs.url).toBe("https://gist.github.com/abc123.git");
    expect(cloneArgs.singleBranch).toBe(true);
    expect(cloneArgs.depth).toBe(1);
    // The OAuth token is passed as the git password (same "gist" scope the
    // REST API already uses) — no separate authorization step.
    expect(cloneArgs.onAuth()).toEqual({ username: "alice", password: "gh-token" });

    expect(gitMock.add).toHaveBeenCalledWith(expect.objectContaining({ filepath: "my_screenshot.png" }));
    expect(gitMock.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Add my_screenshot.png",
        author: { name: "alice", email: "alice@users.noreply.github.com" },
      }),
    );

    expect(gitMock.push).toHaveBeenCalledTimes(1);
    const pushArgs = gitMock.push.mock.calls[0]![0] as unknown as { url: string; onAuth: () => unknown };
    expect(pushArgs.url).toBe("https://gist.github.com/abc123.git");
    expect(pushArgs.onAuth()).toEqual({ username: "alice", password: "gh-token" });
  });

  it("returns 502 when the remote rejects the pushed ref", async () => {
    gitMock.push.mockResolvedValueOnce({ ok: [], refs: { "refs/heads/main": { error: "denied: permission" } } });
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest({ filename: "a.png", contentBase64: REAL_PNG_BASE64 }, cookie), fakeEnv, "abc123");

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("denied: permission");
  });

  it("returns 502 when the git transport itself fails (e.g. network / auth)", async () => {
    gitMock.clone.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const cookie = await sessionCookieHeader();
    const res = await handleGistImageUpload(imageRequest({ filename: "a.png", contentBase64: REAL_PNG_BASE64 }, cookie), fakeEnv, "abc123");

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("Couldn't push the image to the gist");
    expect(text).toContain("connect ECONNREFUSED");
  });
});
