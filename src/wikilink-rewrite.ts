// Duplicate of client/src/wikilink-rewrite.ts's rewriteWikilinkReferences
// (kept in sync by hand — same pattern as version-grouping.ts's two
// copies). This file has no findWikilinkOccurrences: the Worker only
// ever needs the final rewritten string, never character ranges. The
// code-awareness helper comes from ./markdown-code (also a hand-synced
// Worker copy).
import { replaceOutsideCode } from "./markdown-code";

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

// Exact-match replace-all: only a fence whose captured name is
// *exactly* oldName is touched, same equality rule
// resolveWikilinkTarget already uses for resolution. A [[oldName]] typed
// inside `code` or a ```fence``` is left alone.
export function rewriteWikilinkReferences(content: string, oldName: string, newName: string): string {
  return replaceOutsideCode(content, WIKILINK_RE, (match, name: string) => (name === oldName ? `[[${newName}]]` : match));
}
