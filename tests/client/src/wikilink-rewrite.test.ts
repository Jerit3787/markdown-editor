import { describe, it, expect } from "vitest";
import { rewriteWikilinkReferences, findWikilinkOccurrences } from "../../../client/src/wikilink-rewrite";

describe("rewriteWikilinkReferences", () => {
  it("rewrites a single exact match", () => {
    expect(rewriteWikilinkReferences("See [[Old]] for details", "Old", "New")).toBe("See [[New]] for details");
  });

  it("rewrites multiple occurrences", () => {
    expect(rewriteWikilinkReferences("[[Old]] and [[Old]] again", "Old", "New")).toBe("[[New]] and [[New]] again");
  });

  it("leaves a near-miss untouched", () => {
    expect(rewriteWikilinkReferences("[[OldSuffix]] stays", "Old", "New")).toBe("[[OldSuffix]] stays");
  });

  it("returns the input unchanged when the name never appears", () => {
    expect(rewriteWikilinkReferences("no links here", "Old", "New")).toBe("no links here");
  });

  it("leaves unrelated wikilinks to other names untouched", () => {
    expect(rewriteWikilinkReferences("[[Old]] and [[Other]]", "Old", "New")).toBe("[[New]] and [[Other]]");
  });
});

describe("findWikilinkOccurrences", () => {
  it("returns the character range of each exact match", () => {
    const content = "See [[Old]] here";
    const occurrences = findWikilinkOccurrences(content, "Old");
    expect(occurrences).toEqual([{ from: 4, to: 11 }]);
    expect(content.slice(occurrences[0]!.from, occurrences[0]!.to)).toBe("[[Old]]");
  });

  it("returns one range per occurrence, in order", () => {
    const occurrences = findWikilinkOccurrences("[[Old]] x [[Old]]", "Old");
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.from).toBe(0);
    expect(occurrences[1]!.from).toBe(10);
  });

  it("returns an empty array when the name doesn't appear", () => {
    expect(findWikilinkOccurrences("nothing here", "Old")).toEqual([]);
  });

  it("ignores a near-miss name", () => {
    expect(findWikilinkOccurrences("[[OldSuffix]]", "Old")).toEqual([]);
  });
});
