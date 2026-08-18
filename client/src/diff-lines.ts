import { diffLines, type Change } from "diff";

export interface DiffRow {
  leftText: string | null; // null = blank counterpart cell (this row is add-only)
  rightText: string | null; // null = blank counterpart cell (this row is remove-only)
  leftLine: number | null; // 1-based line number in `before`, null exactly when leftText is null
  rightLine: number | null; // 1-based line number in `after`, null exactly when rightText is null
  type: "same" | "changed" | "removed" | "added";
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing split artifact from a final newline
  return lines;
}

// Pairs a removed run with an immediately-following added run (the shape
// diffLines produces for a same-position replacement) so replaced lines
// share one row instead of stacking as separate remove/add rows.
export function computeDiffRows(before: string, after: string): DiffRow[] {
  const changes: Change[] = diffLines(before, after);
  const rows: DiffRow[] = [];
  // Two independent running counters — each increments only when a row
  // actually consumes a line from that side, which handles same/changed/
  // removed/added rows uniformly with no special-casing.
  let leftLineNo = 1;
  let rightLineNo = 1;
  let i = 0;
  while (i < changes.length) {
    const change = changes[i]!;
    if (!change.added && !change.removed) {
      for (const text of splitLines(change.value)) {
        rows.push({ leftText: text, rightText: text, leftLine: leftLineNo++, rightLine: rightLineNo++, type: "same" });
      }
      i++;
      continue;
    }
    const next = changes[i + 1];
    const pairsWithNext = change.removed && next?.added;
    const removedLines = change.removed ? splitLines(change.value) : [];
    const addedLines = pairsWithNext ? splitLines(next!.value) : change.added ? splitLines(change.value) : [];
    const pairCount = Math.max(removedLines.length, addedLines.length);
    for (let j = 0; j < pairCount; j++) {
      const l = removedLines[j] ?? null;
      const r = addedLines[j] ?? null;
      rows.push({
        leftText: l,
        rightText: r,
        leftLine: l !== null ? leftLineNo++ : null,
        rightLine: r !== null ? rightLineNo++ : null,
        type: l !== null && r !== null ? "changed" : l !== null ? "removed" : "added",
      });
    }
    i += pairsWithNext ? 2 : 1;
  }
  return rows;
}
