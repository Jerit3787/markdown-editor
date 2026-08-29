import { describe, expect, test } from "vitest";
import { scanMarkdownCompatibility } from "../../../client/src/markdown-compat";

describe("scanMarkdownCompatibility", () => {
  test("flags a wikilink as app-only", () => {
    const issues = scanMarkdownCompatibility("See [[Other Doc]] for details.", undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("app-only");
    expect(issues[0].label).toBe("Wikilink");
    expect("See [[Other Doc]] for details.".slice(issues[0].from, issues[0].to)).toBe("[[Other Doc]]");
  });

  test("flags an image reference (key present in images map) as app-only", () => {
    const text = "![pixel](pixel.png)";
    const issues = scanMarkdownCompatibility(text, { "pixel.png": "data:image/png;base64,AAAA" }, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("app-only");
    expect(issues[0].label).toBe("Image reference");
    expect(text.slice(issues[0].from, issues[0].to)).toBe(text);
  });

  test("a real external image URL is not flagged", () => {
    const issues = scanMarkdownCompatibility("![alt](https://example.com/pic.png)", undefined, undefined);
    expect(issues).toHaveLength(0);
  });

  test("flags a diagram reference (body key present in diagrams map) as app-only", () => {
    const text = "```mermaid\ndiagram\n```";
    const issues = scanMarkdownCompatibility(text, undefined, { diagram: "graph TD; A-->B" });
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("app-only");
    expect(issues[0].label).toBe("Diagram reference");
  });

  test("flags real inline Mermaid source as flavor-specific", () => {
    const text = "```mermaid\ngraph TD; A-->B\n```";
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Mermaid diagram");
  });

  test("flags a table as flavor-specific", () => {
    const text = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Table");
  });

  test("flags strikethrough as flavor-specific", () => {
    const issues = scanMarkdownCompatibility("This is ~~wrong~~ right.", undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Strikethrough");
  });

  test("flags a task list item as flavor-specific", () => {
    const issues = scanMarkdownCompatibility("- [ ] todo\n- not a task\n", undefined, undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("flavor-specific");
    expect(issues[0].label).toBe("Task list item");
  });

  test("flags a footnote reference as flavor-specific", () => {
    // Without the footnote plugin registered, marked's core lexer has no
    // special handling for `[^1]: A note.` either (it isn't a valid link
    // reference definition, since "A note." isn't a bare URL) — it stays
    // a literal paragraph containing `[^1]` too, so both the usage site
    // and its own definition line are genuinely footnote-bracket syntax
    // and both are correctly flagged.
    const issues = scanMarkdownCompatibility("Fact.[^1]\n\n[^1]: A note.", undefined, undefined);
    const footnoteIssues = issues.filter((i) => i.label === "Footnote reference");
    expect(footnoteIssues).toHaveLength(2);
    expect(footnoteIssues.every((i) => i.category === "flavor-specific")).toBe(true);
  });

  test("flags inline and block math as flavor-specific", () => {
    const issues = scanMarkdownCompatibility("Inline $x + y$ and block:\n\n$$E = mc^2$$", undefined, undefined);
    const math = issues.filter((i) => i.label === "Math");
    expect(math).toHaveLength(2);
    expect(math.every((i) => i.category === "flavor-specific")).toBe(true);
  });

  test("two dollar amounts in prose are not flagged as math", () => {
    const issues = scanMarkdownCompatibility("It costs $5 and $10.", undefined, undefined);
    expect(issues.filter((i) => i.label === "Math")).toHaveLength(0);
  });

  test("nothing inside a fenced code block or inline code span is flagged", () => {
    const text = ["```", "~~not strikethrough~~", "[[not a wikilink]]", "```", "", "Also `$not math$` here."].join("\n");
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    expect(issues).toHaveLength(0);
  });

  test("issues are sorted by ascending position", () => {
    const text = "$x$ then ~~y~~ then [[Z]]";
    const issues = scanMarkdownCompatibility(text, undefined, undefined);
    for (let i = 1; i < issues.length; i++) {
      expect(issues[i].from).toBeGreaterThanOrEqual(issues[i - 1].from);
    }
  });

  test("a clean document has no issues", () => {
    const issues = scanMarkdownCompatibility("# Heading\n\nJust a normal paragraph.\n", undefined, undefined);
    expect(issues).toHaveLength(0);
  });

  test("flags a definition list", () => {
    const issues = scanMarkdownCompatibility("Apple\n:   A fruit\n", undefined, undefined);
    expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Definition list" }));
  });

  test("flags superscript", () => {
    const issues = scanMarkdownCompatibility("2^10^ is 1024", undefined, undefined);
    expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Superscript" }));
  });

  test("flags subscript", () => {
    const issues = scanMarkdownCompatibility("H~2~O", undefined, undefined);
    expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Subscript" }));
  });

  test("does not double-flag strikethrough as subscript", () => {
    const issues = scanMarkdownCompatibility("~~deleted~~", undefined, undefined);
    const labels = issues.map((i) => i.label);
    expect(labels).toContain("Strikethrough");
    expect(labels).not.toContain("Subscript");
  });

  test("does not double-flag a footnote reference as superscript", () => {
    const issues = scanMarkdownCompatibility("A claim.[^1]\n\n[^1]: A note.", undefined, undefined);
    const labels = issues.map((i) => i.label);
    expect(labels).toContain("Footnote reference");
    expect(labels).not.toContain("Superscript");
  });

  test("flags a pandoc-style citation", () => {
    const issues = scanMarkdownCompatibility("A claim.[@Smith2020]", undefined, undefined);
    expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Citation" }));
  });

  test("flags a multimarkdown-style citation", () => {
    const issues = scanMarkdownCompatibility("A claim.[#Smith2020]", undefined, undefined);
    expect(issues).toContainEqual(expect.objectContaining({ category: "flavor-specific", label: "Citation" }));
  });
});
