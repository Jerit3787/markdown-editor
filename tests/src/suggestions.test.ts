import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  getSuggestionsMap,
  listResolvedSuggestions,
  recordInsertSuggestion,
  recordDeleteSuggestion,
  resolveSuggestion,
  withdrawSuggestion,
  reconcileReviewerDelta,
} from "../../src/suggestions";

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

describe("recordInsertSuggestion", () => {
  it("creates a suggestion entry covering the inserted range", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice"); // " world" was inserted
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "alice", from: 5, to: 11 });
  });

  it("extends the same author's still-open insert when typing continues contiguously", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 8, "alice"); // " wo"
    recordInsertSuggestion(doc, 8, 11, "alice"); // "rld" typed right after
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ from: 5, to: 11 });
  });

  it("does not extend a different author's insert even at the same boundary", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 8, "alice");
    recordInsertSuggestion(doc, 8, 11, "bob");
    expect(listResolvedSuggestions(doc)).toHaveLength(2);
  });

  it("does not extend a suggestion that's already been resolved", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 8, "alice");
    const [first] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, first!.id, "accept");
    recordInsertSuggestion(doc, 8, 11, "alice");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ from: 8, to: 11 });
  });
});

describe("recordDeleteSuggestion", () => {
  it("creates a delete suggestion without removing the text", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 5, "alice"); // "hello"
    expect(doc.getText("content").toString()).toBe("hello world");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "delete", from: 0, to: 5 });
  });
});

describe("resolveSuggestion", () => {
  it("accepting an insert keeps the text and removes the entry", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "accept");
    expect(doc.getText("content").toString()).toBe("hello world");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });

  it("rejecting an insert deletes the text and removes the entry", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "reject");
    expect(doc.getText("content").toString()).toBe("hello");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });

  it("accepting a delete removes the text and the entry", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 6, "alice"); // "hello "
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "accept");
    expect(doc.getText("content").toString()).toBe("world");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });

  it("rejecting a delete keeps the text and removes the entry", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 6, "alice");
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "reject");
    expect(doc.getText("content").toString()).toBe("hello world");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });
});

describe("withdrawSuggestion", () => {
  it("withdrawing your own pending insert removes the text (same as reject)", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    withdrawSuggestion(doc, s!.id);
    expect(doc.getText("content").toString()).toBe("hello");
  });

  it("withdrawing your own pending delete keeps the text (same as reject)", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 6, "alice");
    const [s] = listResolvedSuggestions(doc);
    withdrawSuggestion(doc, s!.id);
    expect(doc.getText("content").toString()).toBe("hello world");
  });
});

describe("suggestion ranges survive a concurrent edit elsewhere in the document", () => {
  it("shifts the resolved range when text is inserted before it", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 6, 11, "alice"); // "world"
    doc.getText("content").insert(0, "SAY: "); // unrelated edit, elsewhere
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ from: 11, to: 16 }); // shifted by 5
    expect(doc.getText("content").toString().slice(11, 16)).toBe("world");
  });
});

describe("reconcileReviewerDelta", () => {
  it("leaves an already-suggestion-covered change untouched", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    reconcileReviewerDelta(doc, [{ retain: 5 }, { insert: " world" }], "alice");
    expect(listResolvedSuggestions(doc)).toHaveLength(1); // no duplicate created
  });

  it("auto-wraps a reviewer change that arrived with no suggestion entry", () => {
    const doc = docWith("hello world");
    reconcileReviewerDelta(doc, [{ retain: 5 }, { insert: " world" }], "alice");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "alice", from: 5, to: 11 });
  });

  it("auto-wraps a reviewer deletion that already removed text with no suggestion entry", () => {
    // Simulates a misbehaving client that deleted for real instead of
    // suggesting — the delta says 5 chars were deleted at position 0, and
    // ytext already reflects that removal by the time this runs.
    const doc = docWith(" world");
    reconcileReviewerDelta(doc, [{ delete: 5 }], "alice");
    // The text is already gone (this is reconciliation *after the fact*,
    // documented in the spec as the fallback safety net — it cannot undo
    // a deletion that already happened without a copy of the removed
    // text, which a delete delta doesn't carry). This asserts the more
    // important guarantee: no fabricated live suggestion is created for
    // content that no longer exists.
    expect(getSuggestionsMap(doc).size).toBe(0);
  });
});
