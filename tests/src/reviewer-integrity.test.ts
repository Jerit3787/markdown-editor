import { describe, it, expect } from "vitest";
import { diffOps, unionCovers, removeRanges, reviewerTextRepairs, isValidNewSuggestionEntry } from "../../src/reviewer-integrity";
import type { SuggestionEntry } from "../../src/suggestions";

function applyOps(a: string, ops: ReturnType<typeof diffOps>): string {
  let out = "";
  for (const op of ops) {
    if (op.type === "ins") out += op.text;
    else if (op.type === "keep") out += a.slice(op.aFrom, op.aTo);
    // del contributes nothing
  }
  return out;
}

describe("diffOps", () => {
  it("returns a single keep for identical strings", () => {
    expect(diffOps("hello", "hello")).toEqual([{ type: "keep", aFrom: 0, aTo: 5, text: "" }]);
  });

  it("round-trips a mid-string insertion", () => {
    const ops = diffOps("the fox", "the quick fox");
    expect(applyOps("the fox", ops)).toBe("the quick fox");
    expect(ops.some((o) => o.type === "ins" && o.text.includes("quick"))).toBe(true);
  });

  it("round-trips a mid-string deletion and reports the deleted range in `a` coords", () => {
    const ops = diffOps("the quick brown fox", "the fox");
    expect(applyOps("the quick brown fox", ops)).toBe("the fox");
    const del = ops.find((o) => o.type === "del")!;
    expect("the quick brown fox".slice(del.aFrom, del.aTo)).toBe("quick brown ");
  });

  it("round-trips a replacement (del + ins)", () => {
    const ops = diffOps("color me", "colour me");
    expect(applyOps("color me", ops)).toBe("colour me");
  });

  it("falls back to one del + one ins for a bulk change past the threshold", () => {
    const a = "PFX " + "x".repeat(9000) + " SFX";
    const b = "PFX " + "y".repeat(9000) + " SFX";
    const ops = diffOps(a, b);
    expect(applyOps(a, ops)).toBe(b);
    expect(ops.filter((o) => o.type === "del")).toHaveLength(1);
    expect(ops.filter((o) => o.type === "ins")).toHaveLength(1);
  });
});

describe("unionCovers", () => {
  it("covers a range fully inside one span", () => {
    expect(unionCovers([3, 7], [[0, 10]])).toBe(true);
  });
  it("covers a range spanning two touching spans", () => {
    expect(
      unionCovers(
        [2, 8],
        [
          [0, 5],
          [5, 10],
        ],
      ),
    ).toBe(true);
  });
  it("rejects a range poking outside every span", () => {
    expect(unionCovers([2, 12], [[0, 10]])).toBe(false);
    expect(unionCovers([0, 3], [[5, 10]])).toBe(false);
  });
  it("treats an empty range as covered", () => {
    expect(unionCovers([4, 4], [])).toBe(true);
  });
});

describe("removeRanges", () => {
  it("drops the given spans", () => {
    expect(removeRanges("start NEW end", [[5, 9]])).toBe("start end");
    expect(removeRanges("AA OWN BB", [[3, 6]])).toBe("AA  BB");
  });
  it("handles multiple / unordered / overlapping ranges", () => {
    expect(
      removeRanges("0123456789", [
        [6, 8],
        [2, 4],
        [3, 5],
      ]),
    ).toBe("01589");
  });
  it("returns the whole string when nothing is removed", () => {
    expect(removeRanges("hello", [])).toBe("hello");
  });
});

describe("reviewerTextRepairs", () => {
  // committedBefore = preText minus the reviewer's own pending inserts.
  const R = (pre: string, after: string, own: Array<[number, number]>) => reviewerTextRepairs(removeRanges(pre, own), after);

  it("no repairs when the reviewer only inserted", () => {
    expect(R("the fox", "the quick fox", [])).toEqual([]);
  });

  it("no repairs when the deletion was fully inside the reviewer's own pending insert", () => {
    // pre "start NEW end", own insert [5,9) (" NEW"); reviewer withdrew it
    expect(R("start NEW end", "start end", [[5, 9]])).toEqual([]);
  });

  it("no repairs for a partial withdraw inside the own insert (chars stay as an insert)", () => {
    // pre "start MIDDLE end", own [5,12) (" MIDDLE"); reviewer backspaced "DLE"
    expect(R("start MIDDLE end", "start MID end", [[5, 12]])).toEqual([]);
  });

  it("restores committed text the reviewer deleted (no own inserts)", () => {
    const repairs = R("the quick brown fox", "the fox", []);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toEqual({ at: 4, text: "quick brown " });
  });

  it("restores only the committed part of a mixed deletion", () => {
    // pre "AA OWN BB", own insert [3,6) ("OWN"); reviewer deleted "A OWN B"
    const repairs = R("AA OWN BB", "AB", [[3, 6]]);
    let out = "AB";
    for (const rp of [...repairs].sort((a, b) => b.at - a.at)) out = out.slice(0, rp.at) + rp.text + out.slice(rp.at);
    expect(out).toBe("AA  BB");
  });
});

describe("isValidNewSuggestionEntry (MDE-15)", () => {
  const relPos = { tname: "content", assoc: 0 };
  const base: SuggestionEntry = { kind: "insert", author: "bob", createdAt: 1, from: relPos, to: { ...relPos, assoc: -1 } };

  it("accepts a real self-authored entry with no replies", () => {
    expect(isValidNewSuggestionEntry(base, "bob")).toBe(true);
    expect(isValidNewSuggestionEntry({ ...base, replies: [] }, "bob")).toBe(true);
    expect(isValidNewSuggestionEntry({ ...base, kind: "delete" }, "bob")).toBe(true);
  });

  it("rejects a forged author", () => {
    expect(isValidNewSuggestionEntry({ ...base, author: "alice" }, "bob")).toBe(false);
  });

  it("rejects a brand-new entry that arrives with a discussion thread", () => {
    const forged = { ...base, replies: [{ id: "x", author: "alice", body: "Approved", createdAt: 2 }] };
    expect(isValidNewSuggestionEntry(forged, "bob")).toBe(false);
  });

  it("rejects a malformed shape", () => {
    expect(isValidNewSuggestionEntry(undefined, "bob")).toBe(false);
    expect(isValidNewSuggestionEntry({ ...base, kind: "bogus" as unknown as "insert" }, "bob")).toBe(false);
    expect(isValidNewSuggestionEntry({ ...base, from: {} as unknown as SuggestionEntry["from"] }, "bob")).toBe(false);
  });
});
