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
let parseGistId: typeof import("../../../client/src/gist").parseGistId;
let formatGistDate: typeof import("../../../client/src/gist").formatGistDate;
let extractInlineImages: typeof import("../../../client/src/gist").extractInlineImages;
let gistUpdatePayload: typeof import("../../../client/src/gist").gistUpdatePayload;

beforeAll(async () => {
  (window as any).MDE = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ connected: false }), { status: 200 })),
  );
  ({ errorMessage, pushImagesAndRewrite, parseGistId, formatGistDate, extractInlineImages, gistUpdatePayload } = await import("../../../client/src/gist"));
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

describe("parseGistId (GIST-08)", () => {
  it("accepts a bare gist id", () => {
    expect(parseGistId("aa11bb22cc33dd44ee55ff66")).toBe("aa11bb22cc33dd44ee55ff66");
  });

  it("extracts the id from a full gist URL", () => {
    expect(parseGistId("https://gist.github.com/octocat/aa11bb22cc33dd44ee55ff66")).toBe("aa11bb22cc33dd44ee55ff66");
  });

  it("extracts the id from a URL carrying a #file-… fragment", () => {
    expect(parseGistId("https://gist.github.com/octocat/aa11bb22cc33dd44ee55ff66#file-notes-md")).toBe("aa11bb22cc33dd44ee55ff66");
  });

  it("returns null when there is no id-shaped hex run", () => {
    expect(parseGistId("https://example.com/not-a-gist")).toBeNull();
  });
});

describe("formatGistDate (GIST-10)", () => {
  it("renders an ISO timestamp as a short localized date", () => {
    // Locale-independent assertion: the year is always present with the
    // { year: "numeric", month: "short", day: "numeric" } options.
    const out = formatGistDate("2026-03-14T09:30:00Z");
    expect(out).toMatch(/2026/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not throw on a malformed value (falls through to the platform's Invalid Date string)", () => {
    // The try/catch only guards a genuine throw; `new Date("nope")` yields
    // an Invalid Date rather than throwing, so the output is "Invalid Date".
    // Gist timestamps always come from GitHub's API as valid ISO, so this
    // path is defensive only.
    expect(() => formatGistDate("not a date")).not.toThrow();
  });
});

describe("gistUpdatePayload (GIST-02)", () => {
  it("updates in place when the filename is unchanged — key is the filename, no rename prop", () => {
    expect(gistUpdatePayload("notes.md", "notes.md", "body")).toEqual({ "notes.md": { content: "body" } });
  });

  it("renames via GitHub's form — key stays the OLD filename, a `filename` prop names the new one (so no duplicate file is created)", () => {
    expect(gistUpdatePayload("old-name.md", "New Name.md", "body")).toEqual({
      "old-name.md": { filename: "New Name.md", content: "body" },
    });
    // The bug this guards: keying by the fresh name makes GitHub add a
    // second file rather than move the existing one.
    expect(gistUpdatePayload("old-name.md", "New Name.md", "body")).not.toHaveProperty("New Name.md");
  });
});

describe("extractInlineImages (GIST-09)", () => {
  it("converts an inline base64 image in an opened gist into a local ref", () => {
    const { content, images } = extractInlineImages("intro\n\n![a pic](data:image/png;base64,aGVsbG8=)\n\nend");
    const refs = Object.keys(images);
    expect(refs).toHaveLength(1);
    expect(images[refs[0]!]).toBe("data:image/png;base64,aGVsbG8=");
    expect(content).toBe(`intro\n\n![a pic](${refs[0]})\n\nend`);
  });

  it("leaves a plain markdown image link untouched", () => {
    const { content, images } = extractInlineImages("![x](https://example.com/x.png)");
    expect(content).toBe("![x](https://example.com/x.png)");
    expect(images).toEqual({});
  });

  it("gives each inline image its own distinct ref", () => {
    const { images } = extractInlineImages("![a](data:image/png;base64,aGk=) ![b](data:image/gif;base64,aGk=)");
    expect(Object.keys(images)).toHaveLength(2);
  });
});
