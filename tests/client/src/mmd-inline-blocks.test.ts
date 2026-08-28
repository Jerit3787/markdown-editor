import { describe, it, expect } from "vitest";
import { transformDefinitionLists, transformSuperscriptSubscript } from "../../../client/src/mmd-inline-blocks";

describe("transformDefinitionLists", () => {
  it("converts a single term/definition pair", () => {
    const out = transformDefinitionLists("Apple\n:   A fruit\n");
    expect(out).toBe("<dl><dt>Apple</dt><dd>A fruit</dd></dl>\n\n");
  });

  it("converts multiple terms sharing one definition group", () => {
    const out = transformDefinitionLists("Apple\nFruit\n:   A red fruit\n:   Also a company\n");
    expect(out).toBe("<dl><dt>Apple</dt><dt>Fruit</dt><dd>A red fruit</dd><dd>Also a company</dd></dl>\n\n");
  });

  it("renders inline formatting inside a term and a definition", () => {
    const out = transformDefinitionLists("**Apple**\n:   A [fruit](https://example.com)\n");
    expect(out).toContain("<dt><strong>Apple</strong></dt>");
    expect(out).toContain('<dd>A <a href="https://example.com">fruit</a></dd>');
  });

  it("leaves ordinary paragraphs untouched", () => {
    const input = "Just a paragraph.\nWith a second line.\n";
    expect(transformDefinitionLists(input)).toBe(input);
  });

  it("leaves a term line with no following colon-line untouched", () => {
    const input = "Apple\nJust another line.\n";
    expect(transformDefinitionLists(input)).toBe(input);
  });
});

describe("transformSuperscriptSubscript", () => {
  it("converts superscript", () => {
    expect(transformSuperscriptSubscript("2^10^ is 1024")).toBe("2<sup>10</sup> is 1024");
  });

  it("converts subscript", () => {
    expect(transformSuperscriptSubscript("H~2~O is water")).toBe("H<sub>2</sub>O is water");
  });

  it("does not misread a footnote reference as superscript", () => {
    expect(transformSuperscriptSubscript("A claim.[^1]")).toBe("A claim.[^1]");
  });

  it("does not misread GFM strikethrough as subscript", () => {
    expect(transformSuperscriptSubscript("~~deleted text~~")).toBe("~~deleted text~~");
  });

  it("handles both strikethrough and subscript in the same line", () => {
    expect(transformSuperscriptSubscript("~~gone~~ but H~2~O stays")).toBe("~~gone~~ but H<sub>2</sub>O stays");
  });
});
