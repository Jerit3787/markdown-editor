import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { recordInsertSuggestion, recordDeleteSuggestion, listResolvedSuggestions } from "../../../src/suggestions";
import { railAnnotationsForShared, railAnnotationsForLocal, underlyingIds } from "../../../client/src/annotations";
import type { CommentThread } from "../../../client/src/comments";
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

  it("does NOT group a non-contiguous delete + insert", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    recordInsertSuggestion(doc, 8, 11, "alice"); // gap between 5 and 8
    expect(railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT)).toHaveLength(2);
  });

  it("does NOT group a different-author adjacent pair", () => {
    const doc = docWith(CONTENT);
    recordDeleteSuggestion(doc, 0, 5, "alice");
    recordInsertSuggestion(doc, 5, 11, "bob");
    expect(railAnnotationsForShared(listResolvedSuggestions(doc), [], CONTENT)).toHaveLength(2);
  });
});

describe("railAnnotationsForShared — comments", () => {
  const thread: CommentThread = {
    id: "t1",
    from: 0,
    to: 5,
    quote: "hello",
    orphaned: false,
    resolved: false,
    comments: [
      { id: "c1", author: "bob", body: "sure?", createdAt: 10 },
      { id: "c2", author: "alice", body: "yes", createdAt: 20 },
    ],
  };

  it("maps a thread's quote, replies, resolved state and relocated anchor", () => {
    const [a] = railAnnotationsForShared([], [thread], CONTENT);
    expect(a).toMatchObject({ kind: "comment", author: "bob", quote: "hello", resolved: false, orphaned: false, anchorFrom: 0, anchorTo: 5 });
    expect(a.replies).toHaveLength(2);
  });

  it("flags a thread whose quote is gone as orphaned at offset 0", () => {
    const [a] = railAnnotationsForShared([], [{ ...thread, quote: "nowhere" }], CONTENT);
    expect(a).toMatchObject({ orphaned: true, anchorFrom: 0, anchorTo: 0 });
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
