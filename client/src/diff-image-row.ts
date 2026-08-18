// Detects a diff line that IS an image reference and nothing else — the
// only shape DiffView.svelte renders as a thumbnail instead of text. A
// line diff can't sensibly show an inline <img> the way markdown prose
// can (no way to "diff" pixels line-by-line, and an inline image would
// blow out row height), so this deliberately does NOT match a line that
// mixes text with an image ref, or has more than one — those keep
// rendering as plain text, same as before this feature existed.
const IMAGE_ONLY_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

export function parseImageOnlyLine(text: string | null): { alt: string; ref: string } | null {
  if (text === null) return null;
  const match = text.trim().match(IMAGE_ONLY_LINE_RE);
  return match ? { alt: match[1]!, ref: match[2]! } : null;
}

// Same pattern repo-sync.ts's pullFromRepo/fetchAndApply already uses to
// find asset references inside a repo file's raw text — kept as its own
// copy here rather than importing that one, since this call site (a repo
// COMMIT's text, not a doc mid-pull) has no docSlug/entries/blobs context
// to share with it.
export function extractAssetImageRefs(content: string): string[] {
  return [...content.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)].map((m) => m[1]!);
}
