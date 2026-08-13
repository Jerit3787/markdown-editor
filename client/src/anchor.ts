// Intentionally duplicated in src/anchor.ts (Worker code) — this
// codebase has no shared module between client/src/ and src/ today.
// Keep both in sync if this logic ever changes.
export interface AnchorEntry {
  from: number;
  to: number;
  quote: string;
}

export function relocateAnchor(content: string, entry: AnchorEntry): { from: number; to: number } | null {
  if (!entry.quote) return null;
  if (content.slice(entry.from, entry.to) === entry.quote) {
    return { from: entry.from, to: entry.to };
  }
  let bestIdx = -1;
  let bestDistance = Infinity;
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf(entry.quote, searchFrom);
    if (idx === -1) break;
    const distance = Math.abs(idx - entry.from);
    if (distance < bestDistance) {
      bestIdx = idx;
      bestDistance = distance;
    }
    searchFrom = idx + 1;
  }
  if (bestIdx === -1) return null;
  return { from: bestIdx, to: bestIdx + entry.quote.length };
}
