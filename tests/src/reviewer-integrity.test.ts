import { describe, it, expect } from "vitest";
import {
  diffOps,
  unionCovers,
  removeRanges,
  reviewerTextRepairs,
  isValidNewSuggestionEntry,
  absoluteIndexToCommitted,
  committedIndexToAbsolute,
} from "../../src/reviewer-integrity";
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

  it("aligns a replacement mid-string instead of a bulk del+ins (small middle)", () => {
    const ops = diffOps("the quick brown fox", "the slow brown fox");
    expect(applyOps("the quick brown fox", ops)).toBe("the slow brown fox");
    // "brown fox" is kept, not deleted-and-reinserted
    expect(ops.some((o) => o.type === "keep" && "the quick brown fox".slice(o.aFrom, o.aTo).includes("brown"))).toBe(true);
  });

  it("aligns a change at BOTH ends of a large middle without duplicating it (MDE-12)", () => {
    const big = "x".repeat(20_000);
    const a = "A" + big + "B";
    const b = "C" + big + "D";
    const ops = diffOps(a, b);
    expect(applyOps(a, ops)).toBe(b);
    // the 20k identical middle survives as keeps; total del text is 2 chars ("A","B")
    const delChars = ops.filter((o) => o.type === "del").reduce((n, o) => n + (o.aTo - o.aFrom), 0);
    expect(delChars).toBe(2);
  });

  it("falls back to one del + one ins when the edit distance is enormous", () => {
    const a = "P " + "a".repeat(9000) + " S";
    const b = "P " + "z".repeat(9000) + " S"; // 9000 subs -> D ~ 18000, way past the bound
    const ops = diffOps(a, b);
    expect(applyOps(a, ops)).toBe(b);
    expect(ops.filter((o) => o.type === "del")).toHaveLength(1);
    expect(ops.filter((o) => o.type === "ins")).toHaveLength(1);
  });

  it("round-trips a fuzz of small random edits (Myers correctness)", () => {
    // deterministic LCG so a failure is reproducible
    let seed = 0x2f6e2b1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alpha = "abcde \n";
    const pick = () => alpha[Math.floor(rnd() * alpha.length)]!;
    for (let t = 0; t < 400; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 40) }, pick).join("");
      // derive b by a few random splices so both middles stay non-empty-ish
      let b = a;
      const edits = 1 + Math.floor(rnd() * 4);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rnd() * (b.length + 1));
        if (rnd() < 0.5 && b.length > 0) b = b.slice(0, at) + b.slice(at + 1 + Math.floor(rnd() * 3));
        else b = b.slice(0, at) + pick() + b.slice(at);
      }
      const ops = diffOps(a, b);
      expect(applyOps(a, ops)).toBe(b);
      // every del range is within `a`, in ascending order
      let last = -1;
      for (const o of ops.filter((x) => x.type !== "ins")) {
        expect(o.aFrom).toBeGreaterThanOrEqual(last);
        expect(o.aTo).toBeLessThanOrEqual(a.length);
        last = o.aTo;
      }
    }
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

describe("committed <-> absolute index mapping", () => {
  // full text "AB[cc]DE[ff]GH" — inserts at absolute [2,4) and [6,8);
  // committed text is "ABDEGH"
  const R: Array<[number, number]> = [
    [2, 4],
    [6, 8],
  ];

  it("absoluteIndexToCommitted: subtracts inserts fully before the index", () => {
    expect(absoluteIndexToCommitted(0, R)).toBe(0); // 'A'
    expect(absoluteIndexToCommitted(2, R)).toBe(2); // boundary: start of first insert
    expect(absoluteIndexToCommitted(4, R)).toBe(2); // 'D' — first insert subtracted
    expect(absoluteIndexToCommitted(5, R)).toBe(3); // 'E'
    expect(absoluteIndexToCommitted(8, R)).toBe(4); // 'G' — both inserts subtracted
    expect(absoluteIndexToCommitted(10, R)).toBe(6); // end
  });

  it("absoluteIndexToCommitted: null strictly inside an insert", () => {
    expect(absoluteIndexToCommitted(3, R)).toBeNull(); // inside [2,4)
    expect(absoluteIndexToCommitted(7, R)).toBeNull(); // inside [6,8)
  });

  it("absoluteIndexToCommitted: unordered input, empty ranges ignored", () => {
    expect(
      absoluteIndexToCommitted(8, [
        [6, 8],
        [2, 4],
        [9, 9],
      ]),
    ).toBe(4);
    expect(absoluteIndexToCommitted(5, [])).toBe(5);
  });

  it("committedIndexToAbsolute: adds back the inserts before the position", () => {
    expect(committedIndexToAbsolute(0, R)).toBe(0);
    expect(committedIndexToAbsolute(2, R)).toBe(4); // 'D' sits after [2,4)
    expect(committedIndexToAbsolute(3, R)).toBe(5); // 'E'
    expect(committedIndexToAbsolute(4, R)).toBe(8); // 'G' sits after both
    expect(committedIndexToAbsolute(6, R)).toBe(10);
  });

  it("committedIndexToAbsolute: inclusive flag decides an insert exactly at the position", () => {
    const r: Array<[number, number]> = [[3, 5]];
    expect(committedIndexToAbsolute(3, r, true)).toBe(5); // from side: land after the insert
    expect(committedIndexToAbsolute(3, r, false)).toBe(3); // to side: stay before it
  });

  it("round-trips an interior index", () => {
    for (const c of [0, 1, 2, 3, 4, 5, 6]) {
      const abs = committedIndexToAbsolute(c, R);
      expect(absoluteIndexToCommitted(abs, R)).toBe(c);
    }
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

  it("restores only the changed runs, not the whole shared middle (MDE-12 property)", () => {
    // `commonInfix` is a known-large common subsequence of pre-minus-own
    // and after, so a correct repair set restores at most
    // (committed.length - commonInfix.length) characters — the old bulk
    // fallback restored the entire committed middle.
    const cases: Array<{ pre: string; after: string; own: Array<[number, number]>; commonInfix: string }> = [
      { pre: "the quick brown fox jumps far", after: "the brown fox jumps", own: [], commonInfix: " brown fox jumps" },
      { pre: "A" + "x".repeat(15_000) + "B", after: "C" + "x".repeat(15_000) + "D", own: [], commonInfix: "x".repeat(15_000) },
      { pre: "start OWN middle end", after: "start middle end", own: [[6, 9]], commonInfix: "start middle end" },
      { pre: "TOP\n" + "line\n".repeat(4000) + "BOT", after: "top\n" + "line\n".repeat(4000) + "bot", own: [], commonInfix: "\n" + "line\n".repeat(4000) },
    ];

    function isSubsequence(needle: string, hay: string): boolean {
      let i = 0;
      for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
      return i === needle.length;
    }

    for (const { pre, after, own, commonInfix } of cases) {
      const committed = removeRanges(pre, own);
      expect(isSubsequence(commonInfix, committed)).toBe(true);
      expect(isSubsequence(commonInfix, after)).toBe(true);

      const repairs = reviewerTextRepairs(committed, after);
      const restored = repairs.reduce((n, r) => n + r.text.length, 0);
      expect(restored).toBeLessThanOrEqual(committed.length - commonInfix.length);

      // and the repaired text really does contain every committed char in order
      let out = after;
      for (const r of [...repairs].sort((a, b) => b.at - a.at)) out = out.slice(0, r.at) + r.text + out.slice(r.at);
      expect(isSubsequence(committed, out)).toBe(true);
    }
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

  it("accepts an entry authored by an anon: id actor, rejects a different anon id", () => {
    const e = { ...base, author: "anon:abc123" };
    expect(isValidNewSuggestionEntry(e, "anon:abc123")).toBe(true);
    expect(isValidNewSuggestionEntry(e, "anon:other0")).toBe(false);
  });
});
