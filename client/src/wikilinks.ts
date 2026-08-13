import type { Doc } from "./types";

// \n excluded so a stray "[[" is never matched across a block/line
// boundary — a real wikilink is always typed on one line.
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

// Converts [[Name]] into a marked-parseable link using a custom
// "wikilink:" scheme, applied before marked.parse() ever sees the
// text (see app.ts's updatePreview) — its renderer.link override
// decodes the name back out and resolves it against the current
// document list at render time.
export function transformWikilinks(content: string): string {
  return content.replace(WIKILINK_RE, (_match, name: string) => `[${name}](wikilink:${encodeURIComponent(name)})`);
}

export function resolveWikilinkTarget(name: string, docs: Doc[]): Doc | undefined {
  return docs.find((d) => d.name === name);
}

// Every OTHER document (excludeId) whose raw content contains a
// [[targetName]] reference — a plain substring scan of the [[...]]
// syntax itself, the same "good enough, documents are small" stance
// refreshDocNoteAnchors/refreshCommentAnchors already take for their
// own per-document content scans.
export function findBacklinks(targetName: string, docs: Doc[], excludeId: string): Doc[] {
  const needle = `[[${targetName}]]`;
  return docs.filter((d) => d.id !== excludeId && d.content.includes(needle));
}
