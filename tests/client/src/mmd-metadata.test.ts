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

  it("parses the new HTML-comment-wrapped format", () => {
    const { metadata, body } = parseMetadataBlock("<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\n# Heading\n");
    expect(metadata).toEqual([
      { key: "Title", value: "My Doc" },
      { key: "Author", value: "Jane" },
    ]);
    expect(body).toBe("# Heading\n");
  });

  it("supports an indented continuation line inside the wrapped format", () => {
    const { metadata, body } = parseMetadataBlock("<!--\nTitle: My Very\n  Long Title\n-->\n\nBody.\n");
    expect(metadata).toEqual([{ key: "Title", value: "My Very Long Title" }]);
    expect(body).toBe("Body.\n");
  });

  it("unescapes a value's escaped '-->' when parsing the wrapped format", () => {
    const { metadata, body } = parseMetadataBlock("<!--\nNote: see a--\u200B>b for details\n-->\n\nBody.\n");
    expect(metadata).toEqual([{ key: "Note", value: "see a-->b for details" }]);
    expect(body).toBe("Body.\n");
  });

  it("unescapes a value's escaped '--!>' when parsing the wrapped format", () => {
    const { metadata, body } = parseMetadataBlock("<!--\nNote: see a--!\u200B>b for details\n-->\n\nBody.\n");
    expect(metadata).toEqual([{ key: "Note", value: "see a--!>b for details" }]);
    expect(body).toBe("Body.\n");
  });

  it("leaves the document untouched when a leading HTML comment never closes", () => {
    const input = "<!--\nTitle: My Doc\n# Heading\n";
    const { metadata, body } = parseMetadataBlock(input);
    expect(metadata).toEqual([]);
    expect(body).toBe(input);
  });

  it("leaves the document untouched when a leading HTML comment contains no metadata lines", () => {
    const input = "<!--\njust a plain note, not metadata\n-->\n\n# Heading\n";
    const { metadata, body } = parseMetadataBlock(input);
    expect(metadata).toEqual([]);
    expect(body).toBe(input);
  });
});

describe("serializeMetadataBlock", () => {
  it("returns body unchanged when metadata is empty", () => {
    expect(serializeMetadataBlock([], "Body text.\n")).toBe("Body text.\n");
  });

  it("wraps metadata in an HTML comment", () => {
    const result = serializeMetadataBlock(
      [
        { key: "Title", value: "My Doc" },
        { key: "Author", value: "Jane" },
      ],
      "# Heading\n",
    );
    expect(result).toBe("<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\n# Heading\n");
  });

  it("escapes a value containing '-->' so the wrapping comment can't be closed early", () => {
    const serialized = serializeMetadataBlock([{ key: "Note", value: "see a-->b for details" }], "Body.\n");
    expect(serialized).not.toMatch(/see a-->b/);
    const { metadata, body } = parseMetadataBlock(serialized);
    expect(metadata).toEqual([{ key: "Note", value: "see a-->b for details" }]);
    expect(body).toBe("Body.\n");
  });

  // HTML's comment-parsing state machine also treats "--!>" as a closing
  // sequence ("comment end bang state"), a legacy compatibility quirk from
  // pre-HTML5 markup — a value containing it would leak the rest of the
  // comment just as surely as a literal "-->" would if left unescaped.
  it("escapes a value containing '--!>' so the wrapping comment can't be closed early", () => {
    const serialized = serializeMetadataBlock([{ key: "Note", value: "see a--!>b for details" }], "Body.\n");
    expect(serialized).not.toMatch(/see a--!>b/);
    const { metadata, body } = parseMetadataBlock(serialized);
    expect(metadata).toEqual([{ key: "Note", value: "see a--!>b for details" }]);
    expect(body).toBe("Body.\n");
  });

  it("escapes '-->' found in a key so it can't prematurely close the wrapping comment", () => {
    const serialized = serializeMetadataBlock(
      [
        { key: "Foo-->Bar", value: "x" },
        { key: "Real", value: "y" },
      ],
      "Body.\n",
    );
    // The comment's real closing marker must be the one right before the
    // blank line and body, not one smuggled in from the first pair's key
    // — otherwise "Real: y" and the body itself would leak outside the
    // comment as visible text.
    expect(serialized.endsWith("-->\n\nBody.\n")).toBe(true);
    const closeAt = serialized.indexOf("-->\n\nBody.\n");
    expect(serialized.slice(0, closeAt)).not.toMatch(/--!?>/);
  });

  it("upgrades a legacy bare-format document to the wrapped format when re-serialized", () => {
    const legacy = "Title: My Doc\nAuthor: Jane\n\nBody text.\n";
    const { metadata, body } = parseMetadataBlock(legacy);
    expect(serializeMetadataBlock(metadata, body)).toBe("<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\nBody text.\n");
  });

  it("round-trips a wrapped-format document exactly", () => {
    const original = "<!--\nTitle: My Doc\nAuthor: Jane\n-->\n\nBody text.\n";
    const { metadata, body } = parseMetadataBlock(original);
    expect(serializeMetadataBlock(metadata, body)).toBe(original);
  });
});
