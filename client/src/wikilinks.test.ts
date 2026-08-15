import { describe, it, expect } from "vitest";
import { transformWikilinks, resolveWikilinkTarget, findBacklinks } from "./wikilinks";
import type { Doc } from "./types";

describe("transformWikilinks", () => {
  it("converts [[Name]] into a wikilink-scheme markdown link", () => {
    expect(transformWikilinks("See [[My Notes]] for details")).toBe("See [My Notes](wikilink:My%20Notes) for details");
  });

  it("round-trips a name containing parens", () => {
    expect(transformWikilinks("[[Notes (draft)]]")).toBe("[Notes (draft)](wikilink:Notes%20(draft))");
  });

  it("leaves ordinary markdown links untouched", () => {
    expect(transformWikilinks("[a link](https://example.com)")).toBe("[a link](https://example.com)");
  });

  it("converts multiple wikilinks in the same string", () => {
    expect(transformWikilinks("[[A]] and [[B]]")).toBe("[A](wikilink:A) and [B](wikilink:B)");
  });
});

describe("resolveWikilinkTarget", () => {
  const docs: Doc[] = [{ id: "1", name: "Recipes", content: "", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }];

  it("finds an exact name match", () => {
    expect(resolveWikilinkTarget("Recipes", docs)?.id).toBe("1");
  });

  it("returns undefined for no match", () => {
    expect(resolveWikilinkTarget("Nope", docs)).toBeUndefined();
  });
});

describe("findBacklinks", () => {
  const docs: Doc[] = [
    { id: "1", name: "Target", content: "", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
    { id: "2", name: "Linker", content: "See [[Target]] here", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
    { id: "3", name: "NonLinker", content: "no links here", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
  ];

  it("finds a document referencing the target", () => {
    expect(findBacklinks("Target", docs, "1").map((d) => d.id)).toEqual(["2"]);
  });

  it("excludes the target document itself even if it self-references", () => {
    const selfRef: Doc[] = [{ id: "1", name: "Target", content: "[[Target]]", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }];
    expect(findBacklinks("Target", selfRef, "1")).toEqual([]);
  });
});
