// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderVersionPreview } from "../../../client/src/version-preview";
import type { Doc } from "../../../client/src/types";

function fakeDoc(images: Record<string, string>): Doc {
  return { id: "d1", name: "d", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images };
}

describe("renderVersionPreview", () => {
  it("renders markdown to sanitized HTML in the container", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("# Title\n\nSome **bold** text.\n", undefined, el);
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
  });

  it("resolves an image reference against the version's own image map (same as the live preview)", async () => {
    const el = document.createElement("div");
    const dataUri = "data:image/png;base64,AAAA";
    await renderVersionPreview("![a pic](img-1)\n", fakeDoc({ "img-1": dataUri }), el);
    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(dataUri);
    expect(img.getAttribute("alt")).toBe("a pic");
  });

  it("leaves an unknown image reference as its raw href", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("![x](not-in-map.png)\n", fakeDoc({}), el);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("not-in-map.png");
  });

  it("strips a <script> tag from the rendered version (DOMPurify)", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("ok\n\n<script>window.__x = 1<\/script>\n", undefined, el);
    expect(el.querySelector("script")).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
  });

  it("replaces the container's previous content on each call", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("first\n", undefined, el);
    await renderVersionPreview("second\n", undefined, el);
    expect(el.textContent).toContain("second");
    expect(el.textContent).not.toContain("first");
  });
});
