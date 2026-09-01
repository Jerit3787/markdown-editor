import type { WhatsNewEntry, WhatsNewCategory } from "./whats-new-entries";

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

export interface WhatsNewCategoryGroup {
  category: WhatsNewCategory;
  entries: WhatsNewEntry[]; // newest-first within the category
}

// Groups by category in the order each category first appears in `all`
// (i.e. the order its oldest entry shipped) — `all` itself is oldest-
// first, so a plain forward pass naturally builds each category's own
// list oldest-first too; reversed at the end for newest-first browsing
// (a topic's latest change first, unlike the auto-open catch-up flow
// which stays oldest-first by nature of "here's what you missed, in
// order").
export function groupByCategory(all: WhatsNewEntry[]): WhatsNewCategoryGroup[] {
  const order: WhatsNewCategory[] = [];
  const byCategory = new Map<WhatsNewCategory, WhatsNewEntry[]>();
  for (const entry of all) {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, []);
      order.push(entry.category);
    }
    byCategory.get(entry.category)!.push(entry);
  }
  return order.map((category) => ({
    category,
    entries: [...byCategory.get(category)!].reverse(),
  }));
}
