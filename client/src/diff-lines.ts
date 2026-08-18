import { diffLines, diffWordsWithSpace, type Change } from "diff";

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  leftText: string | null; // null = blank counterpart cell (this row is add-only)
  rightText: string | null; // null = blank counterpart cell (this row is remove-only)
  leftLine: number | null; // 1-based line number in `before`, null exactly when leftText is null
  rightLine: number | null; // 1-based line number in `after`, null exactly when rightText is null
  leftSegments: DiffSegment[] | null; // populated only when type is "changed"
  rightSegments: DiffSegment[] | null; // populated only when type is "changed"
  type: "same" | "changed" | "removed" | "added";
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing split artifact from a final newline
  return lines;
}

function computeIntralineSegments(left: string, right: string): { leftSegments: DiffSegment[]; rightSegments: DiffSegment[] } {
  const parts = diffWordsWithSpace(left, right);
  const leftSegments: DiffSegment[] = [];
  const rightSegments: DiffSegment[] = [];
  for (const part of parts) {
    if (part.added) {
      rightSegments.push({ text: part.value, changed: true });
    } else if (part.removed) {
      leftSegments.push({ text: part.value, changed: true });
    } else {
      leftSegments.push({ text: part.value, changed: false });
      rightSegments.push({ text: part.value, changed: false });
    }
  }
  return { leftSegments, rightSegments };
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
        rows.push({ leftText: text, rightText: text, leftLine: leftLineNo++, rightLine: rightLineNo++, leftSegments: null, rightSegments: null, type: "same" });
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
      const isChanged = l !== null && r !== null;
      const segments = isChanged ? computeIntralineSegments(l, r) : null;
      rows.push({
        leftText: l,
        rightText: r,
        leftLine: l !== null ? leftLineNo++ : null,
        rightLine: r !== null ? rightLineNo++ : null,
        leftSegments: segments ? segments.leftSegments : null,
        rightSegments: segments ? segments.rightSegments : null,
        type: isChanged ? "changed" : l !== null ? "removed" : "added",
      });
    }
    i += pairsWithNext ? 2 : 1;
  }
  return rows;
}

export type UnifiedLineType = "same" | "removed" | "added";

export interface UnifiedLine {
  text: string;
  segments: DiffSegment[] | null;
  type: UnifiedLineType;
  leftLine: number | null;
  rightLine: number | null;
}

// Flattens the two-column row list into a single-column sequence for
// unified-mode rendering — a "changed" row (one line replaced by
// another) expands into two stacked lines, removed first then added,
// matching git/GitHub's own unified diff convention. Segments carry
// straight through so intraline highlighting looks identical to split
// mode, just split across two lines instead of two side-by-side cells.
export function toUnifiedLines(rows: DiffRow[]): UnifiedLine[] {
  const lines: UnifiedLine[] = [];
  for (const row of rows) {
    if (row.type === "same") {
      lines.push({ text: row.leftText ?? "", segments: row.leftSegments, type: "same", leftLine: row.leftLine, rightLine: row.rightLine });
    } else if (row.type === "removed") {
      lines.push({ text: row.leftText ?? "", segments: row.leftSegments, type: "removed", leftLine: row.leftLine, rightLine: null });
    } else if (row.type === "added") {
      lines.push({ text: row.rightText ?? "", segments: row.rightSegments, type: "added", leftLine: null, rightLine: row.rightLine });
    } else {
      lines.push({ text: row.leftText ?? "", segments: row.leftSegments, type: "removed", leftLine: row.leftLine, rightLine: null });
      lines.push({ text: row.rightText ?? "", segments: row.rightSegments, type: "added", leftLine: null, rightLine: row.rightLine });
    }
  }
  return lines;
}
