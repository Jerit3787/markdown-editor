import { describe, it, expect } from "vitest";
import { parseImageOnlyLine, extractAssetImageRefs } from "../../../client/src/diff-image-row";

describe("parseImageOnlyLine", () => {
  it("matches a line that is exactly one image reference", () => {
    expect(parseImageOnlyLine("![a photo](img-key)")).toEqual({ alt: "a photo", ref: "img-key" });
  });

  it("matches with an empty alt text", () => {
    expect(parseImageOnlyLine("![](img-key)")).toEqual({ alt: "", ref: "img-key" });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parseImageOnlyLine("  ![a](img-key)  ")).toEqual({ alt: "a", ref: "img-key" });
  });

  it("returns null for null input", () => {
    expect(parseImageOnlyLine(null)).toBeNull();
  });

  it("returns null for a line mixing text and an image reference", () => {
    expect(parseImageOnlyLine("See this: ![a](img-key)")).toBeNull();
  });

  it("returns null for a line with two image references", () => {
    expect(parseImageOnlyLine("![a](img-1) ![b](img-2)")).toBeNull();
  });

  it("returns null for plain text with no image reference", () => {
    expect(parseImageOnlyLine("just a normal line")).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(parseImageOnlyLine("")).toBeNull();
  });

  it("matches a repo-style assets path ref", () => {
    expect(parseImageOnlyLine("![alt text](assets/my-notes/foo.png)")).toEqual({ alt: "alt text", ref: "assets/my-notes/foo.png" });
  });
});

describe("extractAssetImageRefs", () => {
  it("finds a single assets-path image reference", () => {
    expect(extractAssetImageRefs("# Notes\n\n![a photo](assets/my-notes/foo.png)\n")).toEqual(["assets/my-notes/foo.png"]);
  });

  it("finds multiple assets-path references in one document", () => {
    const content = "![a](assets/notes/a.png)\n\ntext\n\n![b](assets/notes/b.png)\n";
    expect(extractAssetImageRefs(content)).toEqual(["assets/notes/a.png", "assets/notes/b.png"]);
  });

  it("ignores refs that aren't under assets/", () => {
    expect(extractAssetImageRefs("![internal](img-key)\n![external](https://example.com/x.png)\n")).toEqual([]);
  });

  it("returns an empty array for content with no images", () => {
    expect(extractAssetImageRefs("just some text\n")).toEqual([]);
  });
});
