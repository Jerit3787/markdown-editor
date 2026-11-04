// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { inlineRemoteImages } from "../../../client/src/export-images";

function imageIn(src: string): { root: HTMLDivElement; img: HTMLImageElement } {
  const root = document.createElement("div");
  const img = document.createElement("img");
  img.setAttribute("src", src);
  root.appendChild(img);
  return { root, img };
}

describe("inlineRemoteImages", () => {
  it("replaces a remote image with a data URL fetched through the proxy", async () => {
    const { root, img } = imageIn("https://images.example.com/a.png");
    const fetchMock = vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200, headers: { "Content-Type": "image/png" } }));

    const result = await inlineRemoteImages(root, fetchMock);
    expect(result).toEqual({ attempted: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledWith(`/api/image-proxy?url=${encodeURIComponent("https://images.example.com/a.png")}`);
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  it("skips data, relative, and same-origin images", async () => {
    const data = imageIn("data:image/png;base64,AAAA");
    const relative = imageIn("/logo.png");
    const sameOrigin = imageIn("http://localhost:3000/logo.png");
    for (const { root } of [data, relative, sameOrigin]) {
      const fetchMock = vi.fn();
      expect(await inlineRemoteImages(root, fetchMock)).toEqual({ attempted: 0, failed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("keeps the original URL and counts a failed fetch or non-image response", async () => {
    const notFound = imageIn("https://images.example.com/missing.png");
    const notImage = imageIn("https://images.example.com/not-image.png");
    const missingFetch = vi.fn(async () => new Response("gone", { status: 404 }));
    expect(await inlineRemoteImages(notFound.root, missingFetch)).toEqual({ attempted: 1, failed: 1 });
    expect(notFound.img.getAttribute("src")).toBe("https://images.example.com/missing.png");

    const htmlFetch = vi.fn(async () => new Response(new Blob(["<html>"], { type: "text/html" }), { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await inlineRemoteImages(notImage.root, htmlFetch)).toEqual({ attempted: 1, failed: 1 });
    expect(notImage.img.getAttribute("src")).toBe("https://images.example.com/not-image.png");
  });

  it("reports progress before the first fetch and after every attempted image, including failures", async () => {
    const root = document.createElement("div");
    for (const name of ["a", "b", "c"]) {
      const img = document.createElement("img");
      img.setAttribute("src", `https://images.example.com/${name}.png`);
      root.appendChild(img);
    }
    const fetchMock = vi.fn(async (url: string) =>
      decodeURIComponent(String(url)).includes("/b.png")
        ? new Response("gone", { status: 404 })
        : new Response(new Blob(["png"], { type: "image/png" }), { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    const progress: Array<[number, number]> = [];
    await inlineRemoteImages(root, fetchMock, (done, total) => progress.push([done, total]));
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("processes several images and reports only the failures", async () => {
    const root = document.createElement("div");
    for (const name of ["a", "b", "c"]) {
      const img = document.createElement("img");
      img.setAttribute("src", `https://images.example.com/${name}.png`);
      root.appendChild(img);
    }
    const fetchMock = vi.fn(async (url: string) =>
      decodeURIComponent(String(url)).includes("/b.png")
        ? new Response("gone", { status: 404 })
        : new Response(new Blob(["png"], { type: "image/png" }), { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    expect(await inlineRemoteImages(root, fetchMock)).toEqual({ attempted: 3, failed: 1 });
    const sources = [...root.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources[0]).toMatch(/^data:/);
    expect(sources[1]).toBe("https://images.example.com/b.png");
    expect(sources[2]).toMatch(/^data:/);
  });
});
