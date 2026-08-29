import { describe, it, expect } from "vitest";
import { parseMetadataBlock, serializeMetadataBlock } from "../../../client/src/mmd-metadata";

describe("parseMetadataBlock", () => {
  it("parses a simple block", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Doc\nAuthor: Jane\n\n# Heading\n");
    expect(metadata).toEqual([
      { key: "Title", value: "My Doc" },
      { key: "Author", value: "Jane" },
    ]);
    expect(body).toBe("# Heading\n");
  });

  it("joins an indented continuation line into the previous value", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Very\n  Long Title\n\nBody text.\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Very Long Title" }]);
    expect(body).toBe("Body text.\n");
  });

  it("returns the body unchanged when there is no metadata block", () => {
    const input = "Just a heading\n\nSome text.\n";
    const { metadata, body } = parseMetadataBlock(input);
    expect(metadata).toEqual([]);
    expect(body).toBe(input);
  });

  it("stops at the first non-matching, non-blank line even with no blank-line separator", () => {
    const { metadata, body } = parseMetadataBlock("Title: My Doc\nThis is a heading\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Doc" }]);
    expect(body).toBe("This is a heading\n");
  });
});

describe("serializeMetadataBlock", () => {
  it("returns body unchanged when metadata is empty", () => {
    expect(serializeMetadataBlock([], "Body text.\n")).toBe("Body text.\n");
  });

  it("round-trips a single-line-only document exactly", () => {
    const original = "Title: My Doc\nAuthor: Jane\n\nBody text.\n";
    const { metadata, body } = parseMetadataBlock(original);
    expect(serializeMetadataBlock(metadata, body)).toBe(original);
  });
});
