import { describe, it, expect } from "vitest";
import { transformSuggestions } from "../../../client/src/suggestion-preview";
import type { ResolvedSuggestion } from "../../../client/src/suggestions";

function suggestion(over: Partial<ResolvedSuggestion>): ResolvedSuggestion {
  return { id: "s1", kind: "insert", author: "alice", createdAt: 0, from: 0, to: 0, ...over };
}

describe("transformSuggestions", () => {
  it("wraps a pending insert range in <ins>", () => {
    const raw = "hello world";
    const out = transformSuggestions(raw, [suggestion({ kind: "insert", from: 6, to: 11, id: "s1" })]);
    expect(out).toBe('hello <ins class="suggestion-insert" data-suggestion-id="s1">world</ins>');
  });

  it("wraps a pending delete range in <del>", () => {
    const raw = "hello world";
    const out = transformSuggestions(raw, [suggestion({ kind: "delete", from: 0, to: 6, id: "s1" })]);
    expect(out).toBe('<del class="suggestion-delete" data-suggestion-id="s1">hello </del>world');
  });

  it("wraps multiple non-overlapping suggestions in document order", () => {
    const raw = "hello world";
    const out = transformSuggestions(raw, [
      suggestion({ kind: "delete", from: 0, to: 5, id: "s1" }),
      suggestion({ kind: "insert", from: 6, to: 11, id: "s2" }),
    ]);
    expect(out).toBe('<del class="suggestion-delete" data-suggestion-id="s1">hello</del> <ins class="suggestion-insert" data-suggestion-id="s2">world</ins>');
  });

  it("returns the raw text unchanged when there are no suggestions", () => {
    expect(transformSuggestions("hello world", [])).toBe("hello world");
  });
});
