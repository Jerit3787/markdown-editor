// Pure, server-only. Decides which of a reviewer's ytext edits were
// legitimate: a reviewer may insert anywhere (auto-wrapped as a
// suggestion elsewhere) but may only DELETE text that was inside their
// own pending insert suggestion(s). Everything else must be restored.
// Not hand-synced with client/src/.

export interface DiffOp {
  type: "keep" | "del" | "ins";
  aFrom: number;
  aTo: number;
  text: string;
}

const BULK_THRESHOLD = 8192;

export function diffOps(a: string, b: string): DiffOp[] {
  // Trim common prefix / suffix — a reviewer keystroke changes a tiny
  // middle; the LCS DP below then runs on a bounded region.
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
  } else if (aMid.length + bMid.length > BULK_THRESHOLD) {
    ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
    ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
  } else {
    ops.push(...lcsOps(aMid, bMid, aMidFrom));
  }

  if (s > 0) ops.push({ type: "keep", aFrom: a.length - s, aTo: a.length, text: "" });
  return coalesce(ops);
}

// Classic LCS DP over the trimmed middles, emitting ops in a-order.
// `aBase` is added to every a-coordinate so callers get offsets into the
// original string.
function lcsOps(am: string, bm: string, aBase: number): DiffOp[] {
  const n = am.length;
  const m = bm.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      out.push({ type: "keep", aFrom: aBase + i, aTo: aBase + i + 1, text: "" });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", aFrom: aBase + i, aTo: aBase + i + 1, text: "" });
      i++;
    } else {
      out.push({ type: "ins", aFrom: 0, aTo: 0, text: bm[j]! });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", aFrom: aBase + i, aTo: aBase + i + 1, text: "" });
    i++;
  }
  while (j < m) {
    out.push({ type: "ins", aFrom: 0, aTo: 0, text: bm[j]! });
    j++;
  }
  return out;
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
