// @vitest-environment jsdom
// gist.ts sets window.MDE.githubSessionReady = checkSession() at module
// top level (not inside init()/DOMContentLoaded, see its own comment on
// why) — a static import needs window.MDE to already exist by then, which
// only app.ts provides in production. A dynamic import after stubbing
// window.MDE and fetch sidesteps that for this file's tests, the same way
// several component tests already stub window.MDE before mounting.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

let errorMessage: typeof import("../../../client/src/gist").errorMessage;

beforeAll(async () => {
  (window as any).MDE = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ connected: false }), { status: 200 })),
  );
  ({ errorMessage } = await import("../../../client/src/gist"));
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("errorMessage", () => {
  // GitHub's own proxied errors (gist create/update/get) come back JSON-shaped
  // with a "message" field.
  it("reads GitHub's JSON message field", async () => {
    const res = new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    expect(await errorMessage(res)).toBe("Not Found");
  });

  // This app's own validation errors (e.g. gist-images.ts's 400s) are plain
  // text, not JSON — res.json() throws on those, and the message must not
  // collapse to a useless bare "HTTP 400" as a result. This is the exact
  // regression: the toast this endpoint's failures actually produced always
  // read "Gist published, but pushing images failed: HTTP 400" instead of
  // the server's real, specific reason.
  it("falls back to the raw response text when the body isn't JSON", async () => {
    const res = new Response("filename and contentBase64 are required.", { status: 400 });
    expect(await errorMessage(res)).toBe("filename and contentBase64 are required.");
  });

  it("falls back to a bare HTTP status only when the body is truly empty", async () => {
    const res = new Response("", { status: 500 });
    expect(await errorMessage(res)).toBe("HTTP 500");
  });

  it("falls back to the raw text when the JSON body has no message field", async () => {
    const res = new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
    expect(await errorMessage(res)).toBe(JSON.stringify({ error: "bad_request" }));
  });
});
