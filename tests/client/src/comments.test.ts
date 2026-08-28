import { describe, expect, it } from "vitest";
import { countUnresolvedComments } from "../../../client/src/comments";
import type { CommentThread } from "../../../client/src/comments";

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "t1",
    from: 0,
    to: 5,
    quote: "hello",
    orphaned: false,
    resolved: false,
    comments: [],
    ...overrides,
  };
}

describe("countUnresolvedComments", () => {
  it("returns 0 for an empty list", () => {
    expect(countUnresolvedComments([])).toBe(0);
  });

  it("counts only unresolved threads", () => {
    const threads = [thread({ id: "a", resolved: false }), thread({ id: "b", resolved: true }), thread({ id: "c", resolved: false })];
    expect(countUnresolvedComments(threads)).toBe(2);
  });

  it("returns 0 when every thread is resolved", () => {
    const threads = [thread({ id: "a", resolved: true }), thread({ id: "b", resolved: true })];
    expect(countUnresolvedComments(threads)).toBe(0);
  });
});
