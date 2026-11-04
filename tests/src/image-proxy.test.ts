import { describe, it, expect, vi, afterEach } from "vitest";
import { handleImageProxy } from "../../src/image-proxy";

const IMAGE = new Uint8Array([137, 80, 78, 71]);

function proxyReq(target: string, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }): Request {
  return new Request(`https://app.example.com/api/image-proxy?url=${encodeURIComponent(target)}`, { headers });
}

afterEach(() => vi.unstubAllGlobals());

describe("handleImageProxy", () => {
  it("fetches an HTTPS image through a same-origin request", async () => {
    const fetchMock = vi.fn(async () => new Response(IMAGE, { status: 200, headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleImageProxy(proxyReq("https://images.example.com/a.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://images.example.com/a.png",
      expect.objectContaining({ redirect: "manual", headers: expect.objectContaining({ Accept: "image/*" }) }),
    );
  });

  it("follows a safe redirect and re-validates it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://cdn.example.com/a.png" } }))
      .mockResolvedValueOnce(new Response(IMAGE, { status: 200, headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleImageProxy(proxyReq("https://images.example.com/a.png"));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://cdn.example.com/a.png");
  });

  it("accepts an octet-stream image when the path has an image extension", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(IMAGE, { status: 200, headers: { "Content-Type": "application/octet-stream" } })),
    );
    const res = await handleImageProxy(proxyReq("https://images.example.com/a.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("rejects non-image responses and oversized images", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })),
    );
    expect((await handleImageProxy(proxyReq("https://images.example.com/a.png"))).status).toBe(502);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(IMAGE, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(11 * 1024 * 1024) } })),
    );
    expect((await handleImageProxy(proxyReq("https://images.example.com/big.png"))).status).toBe(413);
  });

  it("rejects http, IP literals, local names, userinfo, and non-standard ports", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const url of [
      "http://images.example.com/a.png",
      "https://127.0.0.1/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/a.png",
      "https://foo.internal/a.png",
      "https://user:pass@images.example.com/a.png",
      "https://images.example.com:8443/a.png",
      "https://[::1]/a.png",
    ]) {
      const res = await handleImageProxy(proxyReq(url));
      expect(res.status, url).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow a redirect to a blocked host", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://localhost/secret" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleImageProxy(proxyReq("https://images.example.com/a.png"));
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-site browser request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleImageProxy(proxyReq("https://images.example.com/a.png", { "Sec-Fetch-Site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing url", async () => {
    const res = await handleImageProxy(new Request("https://app.example.com/api/image-proxy", { headers: { "Sec-Fetch-Site": "same-origin" } }));
    expect(res.status).toBe(400);
  });
});
