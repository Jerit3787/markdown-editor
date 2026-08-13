import type { WhatsNewEntry } from "./whats-new-entries";

export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// null lastSeen (nothing ever recorded — a brand-new visitor, or an
// existing user whose browser predates this feature) shows only the
// newest entry, not the full history.
export function missedEntries(all: WhatsNewEntry[], lastSeen: string | null): WhatsNewEntry[] {
  if (lastSeen === null) {
    const newest = all.at(-1);
    return newest ? [newest] : [];
  }
  return all.filter((e) => compareVersions(e.version, lastSeen) > 0);
}
