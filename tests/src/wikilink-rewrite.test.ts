import { describe, it, expect } from "vitest";
import { rewriteWikilinkReferences } from "../../src/wikilink-rewrite";

describe("rewriteWikilinkReferences (Worker copy)", () => {
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
});
