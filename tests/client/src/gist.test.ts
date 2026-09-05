// @vitest-environment jsdom
// gist.ts sets window.MDE.githubSessionReady = checkSession() at module
// top level (not inside init()/DOMContentLoaded, see its own comment on
// why) — a static import needs window.MDE to already exist by then, which
// only app.ts provides in production. A dynamic import after stubbing
// window.MDE and fetch sidesteps that for this file's tests, the same way
// several component tests already stub window.MDE before mounting.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

let errorMessage: typeof import("../../../client/src/gist").errorMessage;
let pushImagesAndRewrite: typeof import("../../../client/src/gist").pushImagesAndRewrite;

beforeAll(async () => {
  (window as any).MDE = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ connected: false }), { status: 200 })),
  );
  ({ errorMessage, pushImagesAndRewrite } = await import("../../../client/src/gist"));
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

describe("pushImagesAndRewrite", () => {
  // The exact reported bug: a doc that merely *mentions* this app's own
  // image-embed syntax as a documentation example — e.g. explaining that a
  // pasted image is referenced as `![alt](data:image/png;base64,...)` —
  // isn't a real image. The old regex's `(.*)$` content group accepted any
  // trailing text, so "..." got treated as real base64 and pushed as a
  // request the server correctly rejected. It must be recognized as a
  // non-match and skipped, the same as any other non-image markdown link,
  // with no fetch call at all.
  it("skips a data URI whose payload isn't real base64 (a documentation example, not an image)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const content = "Images embed as `![alt](data:image/png;base64,...)` — try it!";
    const result = await pushImagesAndRewrite("gist123", content, undefined);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still pushes a real inline base64 data URI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ url: "https://gist.githubusercontent.com/x/raw/image-1.png" })),
    );
    const content = "![alt](data:image/png;base64,aGVsbG8=)";
    const result = await pushImagesAndRewrite("gist123", content, undefined);
    expect(result).toBe("![alt](https://gist.githubusercontent.com/x/raw/image-1.png)");
  });

  it("still pushes a real ref-based image resolved against doc.images", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ url: "https://gist.githubusercontent.com/x/raw/photo.png" })),
    );
    const content = "![alt](photo.png)";
    const result = await pushImagesAndRewrite("gist123", content, { "photo.png": "data:image/png;base64,aGVsbG8=" });
    expect(result).toBe("![alt](https://gist.githubusercontent.com/x/raw/photo.png)");
  });
});
