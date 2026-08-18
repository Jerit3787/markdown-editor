import { describe, it, expect } from "vitest";
import { parseImageOnlyLine } from "./diff-image-row";

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
