// Deterministic per-user accent colour — hash the username into the fixed
// palette. Shared by the collab presence avatars, the Share roster, and
// the Version History author avatars. Kept in its own module so a
// component can use it without importing collab.ts's whole editor stack.
export const COLORS = ["#e64980", "#f76707", "#f59f00", "#40c057", "#12b886", "#228be6", "#7950f2", "#e8590c"];

export function colorForUsername(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}
