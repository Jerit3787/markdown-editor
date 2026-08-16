import { describe, it, expect } from "vitest";
import { slugifyDocName, dedupeRepoPath, rewriteImagesForPush, resolveImagesFromPull } from "./repo-sync";

describe("slugifyDocName", () => {
  it("lowercases, replaces spaces and punctuation with hyphens", () => {
    expect(slugifyDocName("My Notes!")).toBe("my-notes");
  });
  it("falls back to untitled for empty or all-punctuation names", () => {
    expect(slugifyDocName("")).toBe("untitled");
    expect(slugifyDocName("!!!")).toBe("untitled");
  });
});

describe("dedupeRepoPath", () => {
  it("returns the base path unchanged when not taken", () => {
    expect(dedupeRepoPath("notes.md", new Set())).toBe("notes.md");
  });
  it("appends -2, -3... before the extension until free", () => {
    expect(dedupeRepoPath("notes.md", new Set(["notes.md"]))).toBe("notes-2.md");
    expect(dedupeRepoPath("notes.md", new Set(["notes.md", "notes-2.md"]))).toBe("notes-3.md");
  });
});

describe("rewriteImagesForPush", () => {
  it("rewrites an image ref to a relative assets path and returns it as an asset to push", () => {
    const result = rewriteImagesForPush("![a photo](img-1)", "my-notes", { "img-1": "data:image/png;base64,aGVsbG8=" }, undefined);
    expect(result.content).toBe("![a photo](assets/my-notes/img-1.png)");
    expect(result.assets).toEqual([{ path: "assets/my-notes/img-1.png", dataUrl: "data:image/png;base64,aGVsbG8=" }]);
  });

  it("leaves refs with no matching image/diagram untouched", () => {
    const result = rewriteImagesForPush("![x](https://example.com/x.png)", "my-notes", {}, undefined);
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.assets).toEqual([]);
  });
});

describe("resolveImagesFromPull", () => {
  it("resolves an assets-relative link back to an internal ref and an images entry", () => {
    const result = resolveImagesFromPull("![a photo](assets/my-notes/img-1.png)", "my-notes", {
      "assets/my-notes/img-1.png": "data:image/png;base64,aGVsbG8=",
    });
    expect(result.content).toMatch(/^!\[a photo\]\(img-[a-z0-9]+-\d+\)$/);
    const ref = result.content.match(/\(([^)]+)\)/)![1]!;
    expect(result.images[ref]).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("leaves links with no matching blob untouched", () => {
    const result = resolveImagesFromPull("![x](https://example.com/x.png)", "my-notes", {});
    expect(result.content).toBe("![x](https://example.com/x.png)");
    expect(result.images).toEqual({});
  });
});
