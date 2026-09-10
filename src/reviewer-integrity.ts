// Pure, server-only. Decides which of a reviewer's ytext edits were
// legitimate: a reviewer may insert anywhere (auto-wrapped as a
// suggestion elsewhere) but may only DELETE text that was inside their
// own pending insert suggestion(s). Everything else must be restored.
// Not hand-synced with client/src/.

import type { SuggestionEntry } from "./suggestions";
import { isPlausibleRelPos } from "./comment-integrity";

// A brand-new `suggestions` map entry a client just added, validated in
// WorkspaceRoom's suggestionsMap observer. The observer's D3 guard only
// inspected `update`s, so a client could `add` an entry pre-populated
// with a forged author and a fake discussion thread (MDE-15). A genuine
// new entry is authored by the writing session, carries no replies yet
// (those only ever arrive later as an `update`), and is shaped like a
// real suggestion.
export function isValidNewSuggestionEntry(entry: SuggestionEntry | undefined, actor: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  return (
    (entry.kind === "insert" || entry.kind === "delete") &&
    entry.author === actor &&
    typeof entry.createdAt === "number" &&
    isPlausibleRelPos(entry.from) &&
    isPlausibleRelPos(entry.to) &&
    (entry.replies === undefined || (Array.isArray(entry.replies) && entry.replies.length === 0))
  );
}

export interface DiffOp {
  type: "keep" | "del" | "ins";
  aFrom: number;
  aTo: number;
  text: string;
}

// Myers' greedy diff bails past this edit distance and diffOps falls back
// to a coarse whole-middle del + ins. Reached only for a reviewer pasting
// (or programmatically replacing) a large block of *entirely different*
// text — a minimal script there has no practical value, and the fallback
// is still offset-correct (it restores the whole committed middle next to
// the reviewer's replacement). Full-width V snapshots at this bound cost
// ~8 MB worst case, well inside the Worker limit.
const MAX_EDIT_DISTANCE = 1024;

export function diffOps(a: string, b: string): DiffOp[] {
  // Trim common prefix / suffix — a reviewer keystroke changes a tiny
  // middle; the Myers alignment below then runs on a bounded region.
  let p = 0;
  const maxP = Math.min(a.length, b.length);
  while (p < maxP && a[p] === b[p]) p++;
  let s = 0;
  const maxS = Math.min(a.length - p, b.length - p);
  while (s < maxS && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const aMidFrom = p;
  const aMidTo = a.length - s;
  const bMid = b.slice(p, b.length - s);
  const aMid = a.slice(aMidFrom, aMidTo);

  const ops: DiffOp[] = [];
  if (p > 0) ops.push({ type: "keep", aFrom: 0, aTo: p, text: "" });

  if (aMid.length === 0 && bMid.length === 0) {
    // pure prefix/suffix match — nothing in the middle
  } else if (aMid.length === 0) {
    ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
  } else if (bMid.length === 0) {
    ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
  } else {
    const aligned = myersOps(aMid, bMid, aMidFrom);
    if (aligned) {
      ops.push(...aligned);
    } else {
      // edit distance too large to align — restore the whole committed
      // middle next to the reviewer's replacement (conservative but
      // offset-correct; see reviewerTextRepairs)
      ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
      ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
    }
  }

  if (s > 0) ops.push({ type: "keep", aFrom: a.length - s, aTo: a.length, text: "" });
  return coalesce(ops);
}

// Greedy Myers diff over the trimmed middles, emitting ops in a-order.
// `aBase` is added to every a-coordinate so callers get offsets into the
// original string. Returns null when the shortest edit script would be
// longer than MAX_EDIT_DISTANCE (diffOps then falls back to a whole-
// middle del + ins). O((n+m)·D) time; the V snapshots are O(D·(n+m))
// memory, bounded by MAX_EDIT_DISTANCE·2·MAX_EDIT_DISTANCE.
// Caller guarantees am.length > 0 and bm.length > 0.
function myersOps(am: string, bm: string, aBase: number): DiffOp[] | null {
  const n = am.length;
  const m = bm.length;
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  const kOffset = maxD; // k in [-maxD, maxD] -> index k + kOffset in [0, 2·maxD]
  const v = new Int32Array(2 * maxD + 1);
  const trace: Int32Array[] = [];

  let found = -1;
  search: for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // "down" = came from diagonal k+1 (an insert); else from k-1 (a delete)
      const down = k === -d || (k !== d && v[k - 1 + kOffset]! < v[k + 1 + kOffset]!);
      let x = down ? v[k + 1 + kOffset]! : v[k - 1 + kOffset]! + 1;
      let y = x - k;
      while (x < n && y < m && am[x] === bm[y]) {
        x++;
        y++;
      }
      v[k + kOffset] = x;
      if (x >= n && y >= m) {
        found = d;
        break search;
      }
    }
  }
  if (found < 0) return null;

  // Backtrack through the stored V snapshots, emitting ops end-to-start.
  const rev: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vPrev = trace[d]!; // V entering round d (state after round d-1)
    const k = x - y;
    const down = k === -d || (k !== d && vPrev[k - 1 + kOffset]! < vPrev[k + 1 + kOffset]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev[prevK + kOffset]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ type: "keep", aFrom: aBase + x, aTo: aBase + x + 1, text: "" });
    }
    if (down) {
      y--;
      rev.push({ type: "ins", aFrom: 0, aTo: 0, text: bm[y]! });
    } else {
      x--;
      rev.push({ type: "del", aFrom: aBase + x, aTo: aBase + x + 1, text: "" });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rev.push({ type: "keep", aFrom: aBase + x, aTo: aBase + x + 1, text: "" });
  }
  // A correct backtrack always lands on the origin. If it somehow didn't,
  // don't emit a partial (char-dropping) script — bail to the safe
  // whole-middle fallback instead.
  if (x !== 0 || y !== 0) return null;
  rev.reverse();
  return rev;
}

// Merge adjacent same-type ops (keep+keep, del+del, ins+ins).
function coalesce(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type && op.type !== "ins" && last.aTo === op.aFrom) {
      last.aTo = op.aTo;
    } else if (last && last.type === "ins" && op.type === "ins") {
      last.text += op.text;
    } else {
      out.push({ ...op });
    }
  }
  return out;
}

export function unionCovers(range: readonly [number, number], ranges: ReadonlyArray<readonly [number, number]>): boolean {
  if (range[0] >= range[1]) return true;
  const sorted = [...ranges].filter((r) => r[1] > r[0]).sort((x, y) => x[0] - y[0]);
  let cursor = range[0];
  for (const [from, to] of sorted) {
    if (from > cursor) break;
    if (to > cursor) cursor = to;
    if (cursor >= range[1]) return true;
  }
  return cursor >= range[1];
}

// `text` with every [from, to) range removed (ranges may be given in any
// order; overlaps are handled). Used to derive the "committed" document —
// everything that is NOT the reviewer's own pending insert text.
export function removeRanges(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  const sorted = [...ranges].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [from, to] of sorted) {
    if (from > cursor) out += text.slice(cursor, Math.min(from, text.length));
    cursor = Math.max(cursor, to);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

// Absolute index -> its index in the committed text (the full text minus
// `insertRanges`). Subtracts the length of every range that ends at or
// before `absIndex`. null when `absIndex` is strictly inside a range
// (from < absIndex < to) — it has no committed-text position. Ranges may
// be unordered; assumed non-overlapping.
export function absoluteIndexToCommitted(absIndex: number, insertRanges: ReadonlyArray<readonly [number, number]>): number | null {
  const sorted = [...insertRanges].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  let shift = 0;
  for (const [from, to] of sorted) {
    if (to <= absIndex) shift += to - from;
    else if (from < absIndex && absIndex < to) return null;
    else break; // from >= absIndex — this and every later range are past it
  }
  return absIndex - shift;
}

// Committed-text index -> its absolute index in the full text (the inverse
// of absoluteIndexToCommitted). `inclusive` (default true) counts a range
// whose start coincides with the running position, pushing the result
// past that insert — correct for an annotation's `from`. Pass false for a
// `to` boundary so an insert sitting exactly at the annotation's end is
// not pulled inside it.
export function committedIndexToAbsolute(committedIndex: number, insertRanges: ReadonlyArray<readonly [number, number]>, inclusive = true): number {
  const sorted = [...insertRanges].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  let abs = committedIndex;
  for (const [from, to] of sorted) {
    if (inclusive ? from <= abs : from < abs) abs += to - from;
    else break;
  }
  return abs;
}

// The insertions needed to turn `afterText` back into a text where the
// reviewer only ever *added* content — computed by diffing the COMMITTED
// text (preText minus the reviewer's own pending inserts) against
// `afterText`: every `del` in that diff is a committed character the
// reviewer removed, which must be restored. Apply the repairs to the live
// ytext in DESCENDING `at` order. Empty array === no committed text was
// touched. `committedBefore` = removeRanges(preText, ownInsertRanges).
export function reviewerTextRepairs(committedBefore: string, afterText: string): Array<{ at: number; text: string }> {
  const repairs: Array<{ at: number; text: string }> = [];
  let out = 0; // running length of the afterText-equivalent output
  for (const op of diffOps(committedBefore, afterText)) {
    if (op.type === "keep") {
      out += op.aTo - op.aFrom;
    } else if (op.type === "ins") {
      out += op.text.length;
    } else {
      // a committed character the reviewer deleted — restore it
      repairs.push({ at: out, text: committedBefore.slice(op.aFrom, op.aTo) });
      // restored text is NOT in afterText → `out` does not advance
    }
  }
  return repairs;
}
