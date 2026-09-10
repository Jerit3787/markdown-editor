import { describe, it, expect } from "vitest";
import { isValidNewThread, isAllowedThreadTransition } from "../../src/comment-integrity";
import type { CommentThreadEntry } from "../../src/comments-doc";

const REL = { type: null, tname: "content", item: null, assoc: 0 } as unknown as CommentThreadEntry["from"];

function thread(over: Partial<CommentThreadEntry> = {}): CommentThreadEntry {
  return {
    author: "alice",
    createdAt: 1,
    from: REL,
    to: REL,
    quote: "hi",
    resolved: false,
    replies: [{ id: "r1", author: "alice", body: "q?", createdAt: 1 }],
    ...over,
  };
}

describe("isValidNewThread", () => {
  it("accepts a self-authored, single-reply, unresolved thread", () => {
    expect(isValidNewThread(thread(), "alice")).toBe(true);
  });

  it("rejects an author mismatch (thread author or first reply author)", () => {
    expect(isValidNewThread(thread({ author: "bob" }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ replies: [{ id: "r1", author: "bob", body: "q?", createdAt: 1 }] }), "alice")).toBe(false);
  });

  it("rejects a null username", () => {
    expect(isValidNewThread(thread(), null)).toBe(false);
  });

  it("rejects a thread whose relative-position anchors are not real rel-pos JSON", () => {
    // `{}` and `null` both pass a naive `!= null` check but make Yjs throw
    // when resolved — the persistent client-DoS vector.
    expect(isValidNewThread(thread({ from: {} as never }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ to: {} as never }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ from: null as never }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ from: 42 as never }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ from: { assoc: 0 } as never }), "alice")).toBe(false);
    // a real one (index anchor on the "content" text) still passes
    expect(isValidNewThread(thread({ from: { type: null, tname: "content", item: null, assoc: 0 } as never }), "alice")).toBe(true);
  });

  it("rejects multi-reply, pre-resolved, or empty body", () => {
    expect(
      isValidNewThread(
        thread({
          replies: [
            { id: "r1", author: "alice", body: "q?", createdAt: 1 },
            { id: "r2", author: "alice", body: "x", createdAt: 2 },
          ],
        }),
        "alice",
      ),
    ).toBe(false);
    expect(isValidNewThread(thread({ resolved: true }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ replies: [{ id: "r1", author: "alice", body: "   ", createdAt: 1 }] }), "alice")).toBe(false);
  });

  it("accepts a thread authored by an anon: id actor, rejects a different anon id", () => {
    const t = thread({ author: "anon:abc123", replies: [{ id: "r1", author: "anon:abc123", body: "q?", createdAt: 1 }] });
    expect(isValidNewThread(t, "anon:abc123")).toBe(true);
    expect(isValidNewThread(t, "anon:zzz999")).toBe(false);
  });
});

describe("isAllowedThreadTransition", () => {
  it("accepts a resolve toggle with nothing else changed", () => {
    expect(isAllowedThreadTransition(thread(), thread({ resolved: true }), "carol")).toBe(true);
    expect(isAllowedThreadTransition(thread({ resolved: true }), thread({ resolved: false }), "carol")).toBe(true);
  });

  it("accepts one self-authored reply appended", () => {
    const next = thread({
      replies: [
        { id: "r1", author: "alice", body: "q?", createdAt: 1 },
        { id: "r2", author: "bob", body: "yes", createdAt: 5 },
      ],
    });
    expect(isAllowedThreadTransition(thread(), next, "bob")).toBe(true);
  });

  it("rejects a foreign-authored appended reply", () => {
    const next = thread({
      replies: [
        { id: "r1", author: "alice", body: "q?", createdAt: 1 },
        { id: "r2", author: "eve", body: "yes", createdAt: 5 },
      ],
    });
    expect(isAllowedThreadTransition(thread(), next, "bob")).toBe(false);
  });

  it("rejects editing an existing reply, changing author/quote/anchor, or two replies at once", () => {
    expect(isAllowedThreadTransition(thread(), thread({ replies: [{ id: "r1", author: "alice", body: "EDITED", createdAt: 1 }] }), "alice")).toBe(false);
    expect(isAllowedThreadTransition(thread(), thread({ author: "bob" }), "bob")).toBe(false);
    expect(isAllowedThreadTransition(thread(), thread({ quote: "changed" }), "alice")).toBe(false);
    const two = thread({
      replies: [
        { id: "r1", author: "alice", body: "q?", createdAt: 1 },
        { id: "a", author: "bob", body: "1", createdAt: 2 },
        { id: "b", author: "bob", body: "2", createdAt: 3 },
      ],
    });
    expect(isAllowedThreadTransition(thread(), two, "bob")).toBe(false);
  });

  it("rejects a reply append with an empty body", () => {
    const next = thread({
      replies: [
        { id: "r1", author: "alice", body: "q?", createdAt: 1 },
        { id: "r2", author: "bob", body: "  ", createdAt: 5 },
      ],
    });
    expect(isAllowedThreadTransition(thread(), next, "bob")).toBe(false);
  });

  it("rejects a simultaneous resolve toggle AND reply append", () => {
    const next = thread({
      resolved: true,
      replies: [
        { id: "r1", author: "alice", body: "q?", createdAt: 1 },
        { id: "r2", author: "bob", body: "yes", createdAt: 5 },
      ],
    });
    expect(isAllowedThreadTransition(thread(), next, "bob")).toBe(false);
  });
});
