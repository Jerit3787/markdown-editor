import * as Y from "yjs";
import { getSuggestionsMap } from "./suggestions";
import { relocateAnchor } from "./anchor";

// Comment threads on a shared document's Y.Doc — a top-level `comments`
// Y.Map alongside `ytext` ("content"), `imagesMap` ("images"), `metaMap`
// ("name") and `suggestions`. Same relative-position anchoring as
// suggestions.ts; the toRelative / toAbsoluteIndex helpers are copied
// (not imported) so this file stands alone.
//
// KEEP client/src/comments-doc.ts AND src/comments-doc.ts BYTE-IDENTICAL
// — tests/src/comments-doc-parity.test.ts fails CI otherwise. It is the
// same hand-sync discipline suggestions.ts / anchor.ts rely on.

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: number;
  // Display label for an anon:<id> author — see CommentThreadEntry.authorName.
  authorName?: string;
}

export interface CommentThreadEntry {
  author: string;
  createdAt: number;
  from: ReturnType<typeof Y.relativePositionToJSON>;
  to: ReturnType<typeof Y.relativePositionToJSON>;
  quote: string;
  resolved: boolean;
  replies: Reply[];
  // Display label for an anon:<id> author, stamped authoritatively by the
  // server's comments observer from the session's assigned guest name.
  // Absent for a signed-in author (their `author` is already their name).
  authorName?: string;
}

export interface ResolvedCommentThread {
  id: string;
  author: string;
  authorName?: string;
  createdAt: number;
  from: number;
  to: number;
  quote: string;
  resolved: boolean;
  replies: Reply[];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function getCommentsMap(doc: Y.Doc): Y.Map<CommentThreadEntry> {
  return doc.getMap<CommentThreadEntry>("comments");
}

// `to` uses assoc -1 so an edit landing exactly at a thread's end does
// not silently grow the range — the same reasoning suggestions.ts
// documents at length for its own `to` boundary.
function toRelative(ytext: Y.Text, index: number, assoc: 0 | -1 = 0): ReturnType<typeof Y.relativePositionToJSON> {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index, assoc));
}

function toAbsoluteIndex(doc: Y.Doc, ytext: Y.Text, json: ReturnType<typeof Y.relativePositionToJSON>): number | null {
  // A hostile collaborator can write a malformed anchor ({}, null, …)
  // into the map; Yjs throws "Unexpected case" resolving those. Swallow
  // it — a bad thread is dropped from the list, never a crash for every
  // viewer (the server-side isValidNewThread guard should stop it landing
  // in the first place, but this file also runs on already-poisoned docs).
  try {
    const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
    if (!pos || pos.type !== ytext) return null;
    return pos.index;
  } catch {
    return null;
  }
}

// Every live thread, relative positions resolved to absolute offsets.
// When `content` is supplied and the resolved span no longer covers the
// thread's `quote` (a version restore rewrote ytext — Yjs relative
// positions survive that but collapse to a stale offset), re-anchor by
// searching `content` for the quote and rewrite the entry's positions to
// fresh ones. A thread whose quote is gone entirely is dropped. Sorted
// by `from`, then by creation time.
export function listResolvedCommentThreads(doc: Y.Doc, content?: string): ResolvedCommentThread[] {
  const ytext = doc.getText("content");
  const map = getCommentsMap(doc);
  const out: ResolvedCommentThread[] = [];
  const reanchor: { id: string; from: number; to: number }[] = [];
  map.forEach((entry, id) => {
    let from = toAbsoluteIndex(doc, ytext, entry.from);
    let to = toAbsoluteIndex(doc, ytext, entry.to);
    if (typeof content === "string" && entry.quote) {
      const covers = from !== null && to !== null && content.slice(from, to) === entry.quote;
      if (!covers) {
        const loc = relocateAnchor(content, { from: from ?? 0, to: to ?? 0, quote: entry.quote });
        if (loc) {
          from = loc.from;
          to = loc.to;
          reanchor.push({ id, from, to });
        } else {
          from = null;
          to = null;
        }
      }
    }
    if (from === null || to === null) return;
    out.push({
      id,
      author: entry.author,
      authorName: entry.authorName,
      createdAt: entry.createdAt,
      from,
      to,
      quote: entry.quote,
      resolved: entry.resolved,
      replies: entry.replies ?? [],
    });
  });
  if (reanchor.length) {
    doc.transact(() => {
      for (const r of reanchor) {
        const e = map.get(r.id);
        if (e) map.set(r.id, { ...e, from: toRelative(ytext, r.from), to: toRelative(ytext, r.to, -1) });
      }
    }, "comment");
  }
  return out.sort((a, b) => a.from - b.from || a.createdAt - b.createdAt);
}

export function createCommentThread(doc: Y.Doc, from: number, to: number, quote: string, author: string, body: string, now: number = Date.now()): string {
  const ytext = doc.getText("content");
  const map = getCommentsMap(doc);
  const id = uid();
  doc.transact(() => {
    map.set(id, {
      author,
      createdAt: now,
      from: toRelative(ytext, from),
      to: toRelative(ytext, to, -1),
      quote,
      resolved: false,
      replies: [{ id: uid(), author, body, createdAt: now }],
    });
  }, "comment");
  return id;
}

export function addCommentReply(doc: Y.Doc, threadId: string, author: string, body: string, now: number = Date.now()): void {
  const map = getCommentsMap(doc);
  const entry = map.get(threadId);
  if (!entry) return;
  doc.transact(() => {
    map.set(threadId, { ...entry, replies: [...entry.replies, { id: uid(), author, body, createdAt: now }] });
  }, "comment");
}

export function resolveCommentThread(doc: Y.Doc, threadId: string, resolved: boolean): void {
  const map = getCommentsMap(doc);
  const entry = map.get(threadId);
  if (!entry || entry.resolved === resolved) return;
  doc.transact(() => map.set(threadId, { ...entry, resolved }), "comment");
}

export function deleteCommentThread(doc: Y.Doc, threadId: string): void {
  const map = getCommentsMap(doc);
  if (!map.has(threadId)) return;
  doc.transact(() => map.delete(threadId), "comment");
}

// D3 — a reply thread on a suggestion. Kept here (not suggestions.ts) so
// that file stays frozen; `replies` is an optional additive field on
// SuggestionEntry.
export function addSuggestionReply(doc: Y.Doc, suggestionId: string, author: string, body: string, now: number = Date.now()): void {
  const map = getSuggestionsMap(doc);
  const entry = map.get(suggestionId);
  if (!entry) return;
  doc.transact(() => {
    map.set(suggestionId, {
      ...entry,
      replies: [...(entry.replies ?? []), { id: uid(), author, body, createdAt: now }],
    });
  }, "comment");
}

// Convert legacy HTTP-stored comment threads (plain char offsets +
// `comments` array) into relative-position `comments` Y.Map entries.
// Used by the server's one-time migration and the legacy-CollabRoom
// /internal/seed path. A thread whose quote no longer matches anchors at
// offset 0.
export function seedCommentThreadsIntoDoc(
  doc: Y.Doc,
  threads: { id: string; from: number; to: number; quote: string; resolved: boolean; comments: Reply[] }[],
): void {
  const ytext = doc.getText("content");
  const content = ytext.toString();
  const map = getCommentsMap(doc);
  doc.transact(() => {
    for (const t of threads) {
      const loc = relocateAnchor(content, { from: t.from, to: t.to, quote: t.quote });
      const from = loc?.from ?? 0;
      const to = loc?.to ?? 0;
      const first = t.comments[0];
      map.set(t.id, {
        author: first?.author ?? "",
        createdAt: first?.createdAt ?? Date.now(),
        from: toRelative(ytext, from),
        to: toRelative(ytext, to, -1),
        quote: t.quote,
        resolved: t.resolved,
        replies: t.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
      });
    }
  }, "comment-migrate");
}
