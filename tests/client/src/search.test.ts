import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { countMatches } from "../../../client/src/search";

function stateWith(doc: string, head: number): EditorState {
  return EditorState.create({ doc, selection: { anchor: head } });
}

describe("countMatches", () => {
  it("returns zero when there are no matches", () => {
    const state = stateWith("hello world", 0);
    const query = new SearchQuery({ search: "xyz" });
    expect(countMatches(state, query)).toEqual({ total: 0, index: 0 });
  });

  it("returns zero for an empty search string", () => {
    const state = stateWith("hello world", 0);
    const query = new SearchQuery({ search: "" });
    expect(countMatches(state, query)).toEqual({ total: 0, index: 0 });
  });

  it("counts every match and picks the one at or after the cursor", () => {
    const state = stateWith("cat cat cat", 5); // cursor inside the second "cat" (positions 4-7)
    const query = new SearchQuery({ search: "cat" });
    expect(countMatches(state, query)).toEqual({ total: 3, index: 2 });
  });

  it("wraps to the first match when the cursor is after every match", () => {
    const state = stateWith("cat dog", 7);
    const query = new SearchQuery({ search: "cat" });
    expect(countMatches(state, query)).toEqual({ total: 1, index: 1 });
  });

  it("is case-sensitive when the option is set", () => {
    const state = stateWith("Cat cat CAT", 0);
    const query = new SearchQuery({ search: "cat", caseSensitive: true });
    expect(countMatches(state, query)).toEqual({ total: 1, index: 1 });
  });

  it("treats the search string as a regular expression when regexp is set", () => {
    const state = stateWith("cat1 cat2 dog3", 0);
    const query = new SearchQuery({ search: "cat\\d", regexp: true });
    expect(countMatches(state, query)).toEqual({ total: 2, index: 1 });
  });

  it("returns zero for an invalid regular expression instead of throwing", () => {
    const state = stateWith("cat cat", 0);
    const query = new SearchQuery({ search: "cat(", regexp: true });
    expect(() => countMatches(state, query)).not.toThrow();
    expect(countMatches(state, query)).toEqual({ total: 0, index: 0 });
  });
});
