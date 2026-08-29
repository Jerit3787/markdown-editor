import { describe, it, expect } from "vitest";
import { transformCitations, DEFAULT_CITATION_PREFS, type CitationPrefs, type BibEntry } from "../../../client/src/mmd-citations";

function prefs(overrides: Partial<CitationPrefs> = {}): CitationPrefs {
  return { ...DEFAULT_CITATION_PREFS, ...overrides };
}

describe("transformCitations — text source", () => {
  it("renders a numbered citation and strips the definition line, appending a Bibliography section", () => {
    const out = transformCitations("A claim.[@Smith2020]\n\n[@Smith2020]: Smith, J. (2020). Title. Publisher.\n", prefs(), []);
    expect(out).toContain('<sup><a href="#cite-Smith2020">1</a></sup>');
    expect(out).not.toContain("[@Smith2020]: Smith");
    expect(out).toContain('<div class="citation-bibliography">');
    expect(out).toContain('<li id="cite-Smith2020">Smith, J. (2020). Title. Publisher.</li>');
  });

  it("supports the multimarkdown marker style", () => {
    const out = transformCitations("A claim.[#Smith2020]\n\n[#Smith2020]: Smith, J. (2020). Title.\n", prefs({ markerStyle: "multimarkdown" }), []);
    expect(out).toContain('<sup><a href="#cite-Smith2020">1</a></sup>');
  });

  it("leaves an unknown citation key untouched", () => {
    const out = transformCitations("A claim.[@Nobody]\n", prefs(), []);
    expect(out).toBe("A claim.[@Nobody]\n");
  });

  it("reuses the same number for repeated citations of the same key", () => {
    const out = transformCitations("First.[@A] Second.[@A]\n\n[@A]: Ref A.\n", prefs(), []);
    const matches = [...out.matchAll(/#cite-A">(\d+)</g)].map((m) => m[1]);
    expect(matches).toEqual(["1", "1"]);
  });

  it("returns the text unchanged when nothing is cited", () => {
    const input = "Just a paragraph, no citations.\n";
    expect(transformCitations(input, prefs(), [])).toBe(input);
  });
});

describe("transformCitations — structured source", () => {
  const bib: BibEntry[] = [
    { key: "A", author: "Alpha, A.", year: "2019", text: "Alpha, A. (2019). First." },
    { key: "B", author: "Beta, B.", year: "2021", text: "Beta, B. (2021). Second." },
  ];

  it("renders numbered citations from structured entries without needing any typed definition line", () => {
    const out = transformCitations("See [@A] and [@B].\n", prefs({ bibliographySource: "structured" }), bib);
    expect(out).toContain('<sup><a href="#cite-A">1</a></sup>');
    expect(out).toContain('<sup><a href="#cite-B">2</a></sup>');
  });

  it("renders author-year inline citations", () => {
    const out = transformCitations("See [@A].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), bib);
    expect(out).toContain("(Alpha, A., 2019)");
  });

  it("falls back to the key when both author and year are blank", () => {
    const blank: BibEntry[] = [{ key: "X", author: "", year: "", text: "Some reference." }];
    const out = transformCitations("See [@X].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), blank);
    expect(out).toContain("(X)");
  });

  it("renders just the available field when only one of author/year is present", () => {
    const partial: BibEntry[] = [{ key: "X", author: "Xavier", year: "", text: "Some reference." }];
    const out = transformCitations("See [@X].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), partial);
    expect(out).toContain("(Xavier)");
  });

  it("sorts the author-year bibliography alphabetically by author, independent of citation order", () => {
    const out = transformCitations("See [@B] then [@A].\n", prefs({ bibliographySource: "structured", displayStyle: "author-year" }), bib);
    expect(out.indexOf('id="cite-A"')).toBeLessThan(out.indexOf('id="cite-B"'));
  });

  it("only includes entries that are actually cited", () => {
    const out = transformCitations("See [@A].\n", prefs({ bibliographySource: "structured" }), bib);
    expect(out).toContain('id="cite-A"');
    expect(out).not.toContain('id="cite-B"');
  });
});
