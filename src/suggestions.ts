import * as Y from "yjs";

export interface SuggestionEntry {
  kind: "insert" | "delete";
  author: string;
  createdAt: number;
  from: ReturnType<typeof Y.relativePositionToJSON>;
  to: ReturnType<typeof Y.relativePositionToJSON>;
}

export interface ResolvedSuggestion extends Omit<SuggestionEntry, "from" | "to"> {
  id: string;
  from: number;
  to: number;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function getSuggestionsMap(doc: Y.Doc): Y.Map<SuggestionEntry> {
  return doc.getMap<SuggestionEntry>("suggestions");
}

// assoc (Yjs's relative-position association): 0 (default) associates the
// anchor with the character AFTER `index`, meaning new content inserted
// exactly at `index` gets absorbed — the anchor silently moves forward to
// stay past it. -1 associates with the character BEFORE `index` instead,
// so an insertion exactly at that point does NOT move the anchor. A
// suggestion's `to` boundary needs -1: without it, a second reviewer edit
// landing exactly at a pending suggestion's end (the common "keep typing"
// case, or an unrelated edit from someone else) would silently grow that
// suggestion's resolved range before recordInsertSuggestion's own
// contiguous-extend check ever runs, since suggestionInsertListener reads
// positions AFTER the edit has already applied to `ytext` (confirmed
// live: typing two characters in a row extended the first entry with NO
// call touching it, because its `to` anchor had already absorbed the
// second character by the time the comparison ran). `from` keeps the
// default (0): it should move forward with the content it borders when
// something ahead of it shifts, which default association already does.
function toRelative(ytext: Y.Text, index: number, assoc: 0 | -1 = 0): ReturnType<typeof Y.relativePositionToJSON> {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index, assoc));
}

function toAbsoluteIndex(doc: Y.Doc, ytext: Y.Text, json: ReturnType<typeof Y.relativePositionToJSON>): number | null {
  const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
  if (!pos || pos.type !== ytext) return null;
  return pos.index;
}

// Resolves every live suggestion to its current absolute position in the
// document, dropping any whose anchor no longer resolves (e.g. the
// surrounding content was removed some other way, like a version
// restore). Sorted by position — callers render/iterate in document order.
export function listResolvedSuggestions(doc: Y.Doc): ResolvedSuggestion[] {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  const result: ResolvedSuggestion[] = [];
  map.forEach((entry, id) => {
    const from = toAbsoluteIndex(doc, ytext, entry.from);
    const to = toAbsoluteIndex(doc, ytext, entry.to);
    if (from === null || to === null) return;
    result.push({ id, kind: entry.kind, author: entry.author, createdAt: entry.createdAt, from, to });
  });
  return result.sort((a, b) => a.from - b.from);
}

// Extends the same author's still-pending insert suggestion when the new
// range starts exactly where it left off; otherwise creates a new one.
// Only ever called for a range that's already real content in `ytext` —
// this function only ever records metadata, never touches document text.
export function recordInsertSuggestion(doc: Y.Doc, from: number, to: number, author: string, now: number = Date.now()): void {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  let extendId: string | null = null;
  map.forEach((entry, id) => {
    if (extendId || entry.kind !== "insert" || entry.author !== author) return;
    if (toAbsoluteIndex(doc, ytext, entry.to) === from) extendId = id;
  });
  const id = extendId ?? uid();
  const createdAt = extendId ? map.get(extendId)!.createdAt : now;
  const fromJson = extendId ? map.get(extendId)!.from : toRelative(ytext, from);
  doc.transact(() => {
    map.set(id, { kind: "insert", author, createdAt, from: fromJson, to: toRelative(ytext, to, -1) });
  }, "suggestion");
}

// Records a proposed deletion WITHOUT touching `ytext` — callers must
// never have already removed the text; the CodeMirror transaction filter
// blocks the deletion from reaching the document and calls this instead.
export function recordDeleteSuggestion(doc: Y.Doc, from: number, to: number, author: string, now: number = Date.now()): void {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  const id = uid();
  doc.transact(() => {
    map.set(id, { kind: "delete", author, createdAt: now, from: toRelative(ytext, from), to: toRelative(ytext, to, -1) });
  }, "suggestion");
}

// The four-case resolution table from the spec: only a rejected insert or
// an accepted delete actually touches `ytext`; the other two cases just
// drop the suggestion entry, since the text was already in its final
// state.
export function resolveSuggestion(doc: Y.Doc, id: string, outcome: "accept" | "reject"): void {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  const entry = map.get(id);
  if (!entry) return;
  const shouldDeleteText = (entry.kind === "insert" && outcome === "reject") || (entry.kind === "delete" && outcome === "accept");
  doc.transact(() => {
    if (shouldDeleteText) {
      const from = toAbsoluteIndex(doc, ytext, entry.from);
      const to = toAbsoluteIndex(doc, ytext, entry.to);
      if (from !== null && to !== null && to > from) ytext.delete(from, to - from);
    }
    map.delete(id);
  }, "suggestion");
}

// "Make my own proposal go away, without anyone judging it" — always
// results in "the suggested change never happened," which is exactly
// what "reject" already means for both kinds: for an insert it removes
// the never-really-wanted text; for a delete it keeps the original text
// exactly as it always was. Withdraw is just reject, restricted (by the
// UI layer, not here) to the suggestion's own author.
export function withdrawSuggestion(doc: Y.Doc, id: string): void {
  resolveSuggestion(doc, id, "reject");
}

// Server-side integrity net: given the exact insert/delete operations a
// reviewer's update just applied (read from Yjs's own YTextEvent.delta by
// the caller), find any operation NOT already covered by a live
// suggestion entry and create one for it after the fact. Walks the delta
// left-to-right tracking a running document position, same convention as
// Yjs/Quill delta ops (`retain` advances the position without changing
// anything, `insert` and `delete` are the ranges that matter).
export function reconcileReviewerDelta(
  doc: Y.Doc,
  delta: { retain?: number; insert?: string | unknown[]; delete?: number }[],
  author: string,
  now: number = Date.now(),
): void {
  const existing = listResolvedSuggestions(doc);
  let pos = 0;
  for (const op of delta) {
    if (op.retain) {
      pos += op.retain;
    } else if (typeof op.insert === "string" && op.insert.length > 0) {
      const from = pos;
      const to = pos + op.insert.length;
      const covered = existing.some((s) => s.kind === "insert" && s.author === author && s.from <= from && s.to >= to);
      if (!covered) recordInsertSuggestion(doc, from, to, author, now);
      pos = to;
    } else if (op.delete) {
      // The deletion already happened by the time this observer runs
      // (Yjs applies the update before firing the event) — there's no
      // text left at `pos` to anchor a live "pending delete" suggestion
      // to. This is the misbehaving-client fallback path: it cannot undo
      // a deletion that already occurred (no record of what was
      // removed), so no further change is made here. A correctly-
      // behaving reviewer client never reaches this branch, since it
      // never lets a real delete reach `ytext` in the first place.
    }
  }
}
