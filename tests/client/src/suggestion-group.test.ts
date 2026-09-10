import { describe, it, expect } from "vitest";
import { groupSuggestionCards, lineRange } from "../../../client/src/suggestion-group";
import type { RailAnnotation } from "../../../client/src/annotations";

function sug(over: Partial<RailAnnotation>): RailAnnotation {
  return {
    id: over.id ?? "s",
    kind: "suggestion",
    author: over.author ?? "alice",
    createdAt: over.createdAt ?? 1,
    anchorFrom: over.anchorFrom ?? 0,
    anchorTo: over.anchorTo ?? 1,
    changeKind: over.changeKind ?? "insert",
    changeText: over.changeText ?? "x",
    ...over,
  };
}

// "line one here" = indices 0..12, \n at 13; "and line two" = indices 14..25, length 26.
const CONTENT = "line one here\nand line two";

describe("lineRange", () => {
  it("returns [start,end) of the line containing the index", () => {
    expect(lineRange(CONTENT, 0)).toEqual([0, 13]);
    expect(lineRange(CONTENT, 13)).toEqual([0, 13]); // the \n position belongs to line 1's end
    expect(lineRange(CONTENT, 14)).toEqual([14, 26]);
    expect(lineRange(CONTENT, 25)).toEqual([14, 26]);
  });
});

describe("groupSuggestionCards", () => {
  it("groups two same-line, same-author, thread-less suggestions into one card", () => {
    const cards = [sug({ id: "a", anchorFrom: 2, anchorTo: 3, changeText: "A" }), sug({ id: "b", anchorFrom: 8, anchorTo: 9, changeText: "B" })];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out).toHaveLength(1);
    expect(out[0]!.subEdits).toHaveLength(2);
    expect(out[0]!.groupedIds).toEqual(["a", "b"]);
    expect(out[0]!.anchorFrom).toBe(2);
    expect(out[0]!.anchorTo).toBe(9);
    expect(out[0]!.subEdits!.map((s) => s.changeText)).toEqual(["A", "B"]);
  });

  it("keeps a replace-pair member as one 'replace' sub-edit and flattens its ids", () => {
    const cards = [
      sug({
        id: "d1+i1",
        anchorFrom: 1,
        anchorTo: 5,
        changeText: "new",
        replacedText: "old",
        groupedIds: ["d1", "i1"],
        changeKind: undefined,
      }),
      sug({ id: "b", anchorFrom: 9, anchorTo: 10, changeText: "B" }),
    ];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out).toHaveLength(1);
    expect(out[0]!.subEdits![0]).toMatchObject({ kind: "replace", changeText: "new", replacedText: "old", ids: ["d1", "i1"] });
    expect(out[0]!.groupedIds).toEqual(["d1", "i1", "b"]);
  });

  it("does not group across different lines", () => {
    const cards = [sug({ id: "a", anchorFrom: 2 }), sug({ id: "b", anchorFrom: 16 })];
    expect(groupSuggestionCards(cards, CONTENT)).toHaveLength(2);
  });

  it("does not group different authors on one line", () => {
    const cards = [sug({ id: "a", anchorFrom: 2, author: "alice" }), sug({ id: "b", anchorFrom: 8, author: "bob" })];
    expect(groupSuggestionCards(cards, CONTENT)).toHaveLength(2);
  });

  it("does not group a suggestion that carries a reply thread", () => {
    const cards = [sug({ id: "a", anchorFrom: 2, replies: [{ id: "r", author: "alice", body: "hm", createdAt: 1 }] }), sug({ id: "b", anchorFrom: 8 })];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out).toHaveLength(2);
    expect(out.every((c) => !c.subEdits)).toBe(true);
  });

  it("returns a single-on-a-line card unchanged (identity)", () => {
    const one = [sug({ id: "a", anchorFrom: 2 })];
    const out = groupSuggestionCards(one, CONTENT);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(one[0]);
  });

  it("leaves comment cards alone", () => {
    const cards: RailAnnotation[] = [
      { id: "t1", kind: "comment", author: "z", createdAt: 1, anchorFrom: 2, anchorTo: 3, quote: "li" },
      sug({ id: "a", anchorFrom: 5 }),
      sug({ id: "b", anchorFrom: 9 }),
    ];
    const out = groupSuggestionCards(cards, CONTENT);
    expect(out.filter((c) => c.kind === "comment")).toHaveLength(1);
    expect(out.filter((c) => c.subEdits)).toHaveLength(1);
  });
});
