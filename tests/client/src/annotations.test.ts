import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { recordInsertSuggestion, recordDeleteSuggestion, listResolvedSuggestions } from "../../../src/suggestions";
import { railAnnotationsForShared, railAnnotationsForLocal, underlyingIds } from "../../../client/src/annotations";
import type { ResolvedCommentThread } from "../../../client/src/comments-doc";
import type { Note } from "../../../client/src/types";

function docWith(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return d;
}

const CONTENT = "hello world";

describe("railAnnotationsForShared — suggestions", () => {
  it("maps a lone insert suggestion", () => {
    const doc = docWith(CONTENT);
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [a] = railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT);
    expect(a).toMatchObject({ kind: "suggestion", author: "alice", changeKind: "insert", changeText: " world", anchorFrom: 5, anchorTo: 11 });
    expect(a.groupedIds).toBeUndefined();
  });

  it("maps a lone delete suggestion", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    const [a] = railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT);
    expect(a).toMatchObject({ kind: "suggestion", changeKind: "delete", changeText: "hello" });
  });

  it("groups a contiguous same-author delete+insert into one replace card", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice"); // "hello"
    recordInsertSuggestion(doc, 5, 11, "alice"); // " world" lands right after
    const list = listResolvedSuggestions(doc);
    const cards = railAnnotationsForShared(list, [], CONTENT);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "suggestion", replacedText: "hello", changeText: " world" });
    expect(cards[0].groupedIds!.slice().sort()).toEqual(list.map((s) => s.id).sort());
    expect(underlyingIds(cards[0])).toEqual(cards[0].groupedIds);
  });

  it("does NOT form a replace card from a non-contiguous delete + insert (but D4 line-groups them)", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    recordInsertSuggestion(doc, 8, 11, "alice"); // gap between 5 and 8 — not a replace pair
    const cards = railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT);
    expect(cards).toHaveLength(1); // one line, same author, no thread -> one group
    expect(cards[0]!.replacedText).toBeUndefined(); // not a "Replace X -> Y" card
    expect(cards[0]!.subEdits).toHaveLength(2);
  });

  it("does NOT group a different-author adjacent pair", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    recordInsertSuggestion(doc, 5, 11, "bob");
    expect(railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT)).toHaveLength(2);
  });

  it("carries a suggestion's replies onto its RailAnnotation", () => {
    const doc = docWith(CONTENT);
    recordInsertSuggestion(doc, 5, 11, "alice");
    const list = listResolvedSuggestions(doc).map((s) => ({
      ...s,
      replies: [{ id: "r", author: "bob", body: "why?", createdAt: 1 }],
    }));
    const [a] = railAnnotationsForShared(list, [], CONTENT);
    expect(a.replies).toEqual([{ id: "r", author: "bob", body: "why?", createdAt: 1 }]);
  });
});

describe("railAnnotationsForShared — comments", () => {
  const thread: ResolvedCommentThread = {
    id: "t1",
    author: "bob",
    createdAt: 10,
    from: 0,
    to: 5,
    quote: "hello",
    resolved: false,
    replies: [
      { id: "c1", author: "bob", body: "sure?", createdAt: 10 },
      { id: "c2", author: "alice", body: "yes", createdAt: 20 },
    ],
  };

  it("maps a pre-resolved comment thread's fields straight through", () => {
    const [a] = railAnnotationsForShared([], [thread], CONTENT);
    expect(a).toMatchObject({
      kind: "comment",
      author: "bob",
      quote: "hello",
      resolved: false,
      orphaned: false,
      anchorFrom: 0,
      anchorTo: 5,
    });
    expect(a.replies).toHaveLength(2);
  });

  it("does not call relocateAnchor — from/to are used verbatim", () => {
    const moved: ResolvedCommentThread = { ...thread, from: 6, to: 11, quote: "world" };
    const [a] = railAnnotationsForShared([], [moved], CONTENT);
    expect(a).toMatchObject({ anchorFrom: 6, anchorTo: 11, orphaned: false });
  });
});

describe("railAnnotationsForLocal", () => {
  it("maps a note to a single-reply comment card", () => {
    const note: Note = { id: "n1", from: 6, to: 11, quote: "world", orphaned: false, body: "check this", createdAt: 5 };
    const [a] = railAnnotationsForLocal([note], CONTENT);
    expect(a).toMatchObject({ kind: "comment", anchorFrom: 6, anchorTo: 11, quote: "world" });
    expect(a.replies).toEqual([{ id: "n1", author: "", body: "check this", createdAt: 5 }]);
  });
});

describe("displayName + authorName passthrough", () => {
  it("displayName prefers authorName, falls back to author", async () => {
    const { displayName } = await import("../../../client/src/annotations");
    expect(displayName("anon:abc", "Swift Otter")).toBe("Swift Otter");
    expect(displayName("alice", undefined)).toBe("alice");
  });

  it("carries authorName from a resolved suggestion onto the card", () => {
    const sug = [{ id: "s1", kind: "insert" as const, author: "anon:abc", authorName: "Swift Otter", createdAt: 1, from: 0, to: 3, replies: undefined }];
    const [card] = railAnnotationsForShared(sug, [], "abcdef");
    expect(card!.authorName).toBe("Swift Otter");
  });

  it("carries authorName from a resolved comment thread onto the card", () => {
    const t: ResolvedCommentThread = {
      id: "t1",
      author: "anon:abc",
      authorName: "Bold Wren",
      createdAt: 1,
      from: 0,
      to: 3,
      quote: "abc",
      resolved: false,
      replies: [{ id: "r1", author: "anon:abc", body: "hi", createdAt: 1 }],
    };
    const [card] = railAnnotationsForShared([], [t], "abcdef");
    expect(card!.authorName).toBe("Bold Wren");
  });
});

describe("railAnnotationsForShared — line grouping (D4)", () => {
  it("groups two separate same-line, same-author inserts into one card with two sub-edits", () => {
    const doc = docWith("the quick brown fox");
    recordInsertSuggestion(doc, 4, 9, "alice"); // "quick"
    recordInsertSuggestion(doc, 16, 19, "alice"); // "fox" — gap, not a contiguous extend
    const cards = railAnnotationsForShared(listResolvedSuggestions(doc), [], "the quick brown fox");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.subEdits).toHaveLength(2);
    expect(cards[0]!.groupedIds).toEqual(listResolvedSuggestions(doc).map((s) => s.id));
  });

  it("keeps a comment on the same line as its own separate card", () => {
    const doc = docWith("the quick brown fox");
    recordInsertSuggestion(doc, 4, 9, "alice");
    recordInsertSuggestion(doc, 16, 19, "alice");
    const thread: ResolvedCommentThread = {
      id: "t1",
      author: "bob",
      createdAt: 1,
      from: 0,
      to: 3,
      quote: "the",
      resolved: false,
      replies: [{ id: "r1", author: "bob", body: "hi", createdAt: 1 }],
    };
    const cards = railAnnotationsForShared(listResolvedSuggestions(doc), [thread], "the quick brown fox");
    expect(cards.filter((c) => c.kind === "comment")).toHaveLength(1);
    expect(cards.filter((c) => c.subEdits)).toHaveLength(1);
  });
});
