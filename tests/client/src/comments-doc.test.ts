import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  getCommentsMap,
  listResolvedCommentThreads,
  createCommentThread,
  addCommentReply,
  resolveCommentThread,
  deleteCommentThread,
  addSuggestionReply,
  seedCommentThreadsIntoDoc,
} from "../../../client/src/comments-doc";
import { getSuggestionsMap, recordInsertSuggestion, listResolvedSuggestions } from "../../../client/src/suggestions";

function docWith(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return d;
}

describe("comments-doc", () => {
  it("getCommentsMap returns the doc's `comments` top-level map", () => {
    const doc = docWith("hello");
    expect(getCommentsMap(doc)).toBe(doc.getMap("comments"));
  });

  it("createCommentThread stores a thread with one self-authored reply, unresolved", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "is this right?", 100);
    const [t] = listResolvedCommentThreads(doc);
    expect(t).toMatchObject({ id, author: "alice", from: 0, to: 5, quote: "hello", resolved: false });
    expect(t!.replies).toEqual([{ id: expect.any(String), author: "alice", body: "is this right?", createdAt: 100 }]);
  });

  it("addCommentReply appends a reply, leaving resolved and the first reply untouched", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "q?", 100);
    addCommentReply(doc, id, "bob", "yes", 200);
    const [t] = listResolvedCommentThreads(doc);
    expect(t!.replies.map((r) => [r.author, r.body])).toEqual([
      ["alice", "q?"],
      ["bob", "yes"],
    ]);
    expect(t!.resolved).toBe(false);
  });

  it("addCommentReply is a no-op for an unknown thread id", () => {
    const doc = docWith("hello world");
    createCommentThread(doc, 0, 5, "hello", "alice", "q?", 100);
    addCommentReply(doc, "nope", "bob", "yes", 200);
    expect(listResolvedCommentThreads(doc)[0]!.replies).toHaveLength(1);
  });

  it("resolveCommentThread toggles resolved without touching replies", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "q?", 100);
    resolveCommentThread(doc, id, true);
    expect(listResolvedCommentThreads(doc)[0]!.resolved).toBe(true);
    resolveCommentThread(doc, id, false);
    expect(listResolvedCommentThreads(doc)[0]!.resolved).toBe(false);
  });

  it("deleteCommentThread removes the entry", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "q?", 100);
    deleteCommentThread(doc, id);
    expect(listResolvedCommentThreads(doc)).toEqual([]);
  });

  it("a thread's anchor tracks an edit made before it", () => {
    const doc = docWith("hello world");
    createCommentThread(doc, 6, 11, "world", "alice", "q?", 100);
    doc.getText("content").insert(0, "PREFIX ");
    const [t] = listResolvedCommentThreads(doc);
    expect(doc.getText("content").toString().slice(t!.from, t!.to)).toBe("world");
  });

  it("drops a thread whose anchor no longer resolves and whose quote is gone", () => {
    const doc = docWith("alpha beta gamma");
    createCommentThread(doc, 6, 10, "beta", "alice", "q?", 100);
    const ytext = doc.getText("content");
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, "nothing matches here");
    });
    expect(listResolvedCommentThreads(doc, doc.getText("content").toString())).toEqual([]);
  });

  it("re-anchors via quote when the relative position died (version restore)", () => {
    const doc = docWith("alpha beta gamma");
    const id = createCommentThread(doc, 6, 10, "beta", "alice", "q?", 100);
    const ytext = doc.getText("content");
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, "gamma beta alpha");
    });
    const [t] = listResolvedCommentThreads(doc, doc.getText("content").toString());
    expect(t!.id).toBe(id);
    expect(doc.getText("content").toString().slice(t!.from, t!.to)).toBe("beta");
    // the entry's stored positions were rewritten to fresh ones — a
    // subsequent list without `content` still resolves
    expect(listResolvedCommentThreads(doc)[0]!.id).toBe(id);
  });

  it("addSuggestionReply appends a reply onto a SuggestionEntry", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 0, 5, "alice");
    const sid = listResolvedSuggestions(doc)[0]!.id;
    addSuggestionReply(doc, sid, "bob", "why?", 300);
    const entry = getSuggestionsMap(doc).get(sid) as { replies?: { author: string; body: string }[] };
    expect(entry.replies).toEqual([{ id: expect.any(String), author: "bob", body: "why?", createdAt: 300 }]);
  });

  it("seedCommentThreadsIntoDoc converts legacy threads to relative-position entries", () => {
    const doc = docWith("one two three");
    seedCommentThreadsIntoDoc(doc, [
      {
        id: "t1",
        from: 4,
        to: 7,
        quote: "two",
        resolved: true,
        comments: [{ id: "c1", author: "z", body: "b", createdAt: 1 }],
      },
    ]);
    const [t] = listResolvedCommentThreads(doc);
    expect(t).toMatchObject({ id: "t1", from: 4, to: 7, quote: "two", resolved: true });
    expect(t!.replies).toEqual([{ id: "c1", author: "z", body: "b", createdAt: 1 }]);
  });
});
