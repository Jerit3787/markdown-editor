import type { Doc } from "./types";

// Appends -2, -3, ... until the name isn't in `taken` — the shared
// primitive behind both a single ensureUniqueName() call (create/
// rename/duplicate) and stores/docs.ts's load-time normalization pass
// (which accumulates `taken` itself as it walks the stored list).
export function nextAvailableName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

// excludeId lets a document keep comparing against every OTHER
// document without ever colliding with its own unchanged name (e.g.
// renaming a document to the name it already has).
export function ensureUniqueName(name: string, docs: Doc[], excludeId?: string): string {
  const taken = new Set(docs.filter((d) => d.id !== excludeId).map((d) => d.name));
  return nextAvailableName(name, taken);
}
