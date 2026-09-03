// Kept separate from wikilinks.ts (which owns transformWikilinks/
// resolveWikilinkTarget/findBacklinks and imports Doc from ./types) so
// this file has zero dependency on client-only types — it's duplicated
// verbatim as src/wikilink-rewrite.ts for the Worker, same pattern
// version-grouping.ts already established for logic needed identically
// on both sides.
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

// Exact-match replace-all: only a fence whose captured name is
// *exactly* oldName is touched, same equality rule
// resolveWikilinkTarget already uses for resolution.
export function rewriteWikilinkReferences(content: string, oldName: string, newName: string): string {
  return content.replace(WIKILINK_RE, (match, name: string) => (name === oldName ? `[[${newName}]]` : match));
}

export interface WikilinkOccurrence {
  from: number;
  to: number;
}

// Every exact-match occurrence's character range in `content`, for a
// live CodeMirror edit (see app.ts's applyWikilinkRenameToActiveDoc).
export function findWikilinkOccurrences(content: string, name: string): WikilinkOccurrence[] {
  const re = /\[\[([^[\]\n]+)\]\]/g;
  const occurrences: WikilinkOccurrence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] === name) occurrences.push({ from: m.index, to: m.index + m[0].length });
  }
  return occurrences;
}
