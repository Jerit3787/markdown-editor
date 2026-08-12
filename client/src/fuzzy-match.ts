// Case-insensitive subsequence match: every character of `query` must
// appear in `target`, in order, not necessarily contiguous (the same
// approach Sublime Text's "Goto Anything" and most command palettes
// use). Returns null for no match. Lower scores are better matches.
//
// A contiguous match of an N-character query always spans exactly N-1
// target positions — "span" alone can't distinguish a tight match from
// a loose one, and can't ever reach 0 for a multi-character query.
// "slack" (span beyond that unavoidable minimum) is 0 for any
// contiguous match regardless of query length, and grows with how
// scattered the match is — firstMatch is added only as a tiebreaker
// among equally-tight matches, rewarding an earlier start in the
// target, so typing "bold" ranks "Bold" (slack 0, an exact match) above
// a looser, more scattered match (positive slack).
export function fuzzyScore(query: string, target: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatch === -1) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  const span = lastMatch - firstMatch;
  const slack = span - (q.length - 1);
  return firstMatch + slack;
}
