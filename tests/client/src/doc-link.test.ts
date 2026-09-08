import { describe, it, expect } from "vitest";
import { classifyLinkHref, resolveDocRef, looksLikeExternalDomain } from "../../../client/src/doc-link";
import type { Doc } from "../../../client/src/types";

const d = (over: Partial<Doc>): Doc => ({ id: "x", name: "N", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w", ...over });

describe("classifyLinkHref", () => {
  it.each([
    ["#section", "anchor"],
    ["/assets/x.png", "absolute"],
    ["//cdn.example.com/x", "external"],
    ["https://example.com", "external"],
    ["mailto:a@b.com", "external"],
    ["tel:+1234", "external"],
    ["My Note", "doc-ref"],
    ["./docs/notes.md", "doc-ref"],
    ["notes", "doc-ref"],
  ] as const)("%s -> %s", (href, kind) => {
    expect(classifyLinkHref(href)).toBe(kind);
  });
});

describe("resolveDocRef", () => {
  const docs = [d({ id: "1", name: "Design Notes" }), d({ id: "2", name: "API", repoPath: "docs/api.md" })];
  it("matches an exact document name", () => {
    expect(resolveDocRef("Design Notes", docs)?.id).toBe("1");
  });
  it("matches a %20-encoded name", () => {
    expect(resolveDocRef("Design%20Notes", docs)?.id).toBe("1");
  });
  it("matches a name with a .md suffix stripped", () => {
    expect(resolveDocRef("Design Notes.md", docs)?.id).toBe("1");
  });
  it("matches a repoPath, with and without ./", () => {
    expect(resolveDocRef("docs/api.md", docs)?.id).toBe("2");
    expect(resolveDocRef("./docs/api.md", docs)?.id).toBe("2");
  });
  it("matches a repoPath basename against a doc name", () => {
    expect(resolveDocRef("./notes/Design Notes.md", docs)?.id).toBe("1");
  });
  it("returns undefined for no match", () => {
    expect(resolveDocRef("Nope", docs)).toBeUndefined();
  });
});

describe("looksLikeExternalDomain", () => {
  it.each([
    ["example.com", true],
    ["docs.example.com/page", true],
    ["my-site.io", true],
    ["notes.md", false],
    ["My Note", false],
    ["docs/notes", false],
    ["plainword", false],
    ["1.2.3.4", false],
  ] as const)("%s -> %s", (ref, expected) => {
    expect(looksLikeExternalDomain(ref)).toBe(expected);
  });
});
