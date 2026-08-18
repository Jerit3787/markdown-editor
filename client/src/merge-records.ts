// Reconciles two arrays of the same record type by id — used to merge
// what a browser tab is about to save with whatever's already in
// localStorage, instead of blindly overwriting it (see
// docs/superpowers/specs/2026-08-18-multi-tab-save-safety-design.md).
// No tombstones: a record present in only one side always survives,
// even if that means a deletion made elsewhere gets undone. Accepted
// tradeoff — losing a record silently is worse than one reappearing.
export function mergeById<T extends { id: string; updatedAt: number }>(current: T[], external: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of external) byId.set(item.id, item);
  for (const item of current) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}
