import type { Doc } from "./types";
import { codeSegmentRanges, isInsideCode, replaceOutsideCode } from "./markdown-code";

// \n excluded so a stray "[[" is never matched across a block/line
// boundary — a real wikilink is always typed on one line.
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

// Converts [[Name]] into a marked-parseable link using a custom
// "wikilink:" scheme, applied before marked.parse() ever sees the
// text (see Preview.svelte's updatePreview) — its renderer.link override
// decodes the name back out and resolves it against the current
// document list at render time. A [[Name]] typed inside `code` or a
// ```fence``` is left verbatim (replaceOutsideCode).
export function transformWikilinks(content: string): string {
  return replaceOutsideCode(content, WIKILINK_RE, (_match, name: string) => `[${name}](wikilink:${encodeURIComponent(name)})`);
}

export function resolveWikilinkTarget(name: string, docs: Doc[]): Doc | undefined {
  return docs.find((d) => d.name === name);
}

// True when `content` contains a [[targetName]] reference OUTSIDE any
// code span / fence — a [[X]] shown as literal sample text is not a
// real link, so it must not count as a backlink or a rename target.
function hasWikilinkOutsideCode(content: string, targetName: string): boolean {
  if (!content.includes(`[[${targetName}]]`)) return false; // fast reject
  const ranges = codeSegmentRanges(content);
  const re = /\[\[([^[\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] === targetName && !isInsideCode(ranges, m.index, m.index + m[0].length)) return true;
  }
  return false;
}

// Every OTHER document (excludeId) whose content contains a
// [[targetName]] reference outside code — a plain scan of the [[...]]
// syntax itself, the same "good enough, documents are small" stance
// refreshDocNoteAnchors/refreshCommentAnchors already take for their
// own per-document content scans.
export function findBacklinks(targetName: string, docs: Doc[], excludeId?: string): Doc[] {
  return docs.filter((d) => d.id !== excludeId && hasWikilinkOutsideCode(d.content, targetName));
}
