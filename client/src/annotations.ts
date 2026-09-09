import type { ResolvedSuggestion } from "./suggestions";
import type { ResolvedCommentThread } from "./comments-doc";
import type { Note } from "./types";
import { relocateAnchor } from "./anchor";

// One normalised shape for everything the annotation rail renders — a
// suggestion or a comment thread (both from the doc's Y.Doc), or a
// local-doc note. The rail and the AnnotationCard component only ever
// see this; neither knows the source.
export interface RailAnnotation {
  id: string;
  kind: "comment" | "suggestion";
  author: string;
  createdAt: number;
  anchorFrom: number;
  anchorTo: number;
  // comment
  quote?: string;
  resolved?: boolean;
  orphaned?: boolean;
  replies?: { id: string; author: string; body: string; createdAt: number }[];
  // suggestion
  changeKind?: "insert" | "delete";
  changeText?: string; // inserted text (insert / replace) or removed text (delete)
  replacedText?: string; // set only for a replace: the removed text
  groupedIds?: string[]; // the underlying suggestion entry ids when this card is a replace
}

/** The underlying suggestion-entry / thread ids a card represents. */
export function underlyingIds(a: RailAnnotation): string[] {
  return a.groupedIds ?? [a.id];
}

function suggestionCards(suggestions: ResolvedSuggestion[], content: string): RailAnnotation[] {
  const sorted = [...suggestions].sort((a, b) => a.from - b.from);
  const out: RailAnnotation[] = [];
  const used = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (used.has(s.id)) continue;
    const next = sorted[i + 1];
    // A replace: this entry's end touches the next entry's start, same
    // author, opposite kind. suggestionTransactionFilter always emits the
    // delete first (lower `from`) then the insert at the deleted range's
    // end, so `s` is the delete and `next` the insert — but tolerate
    // either order.
    if (next && !used.has(next.id) && next.author === s.author && next.kind !== s.kind && next.from === s.to) {
      const del = s.kind === "delete" ? s : next;
      const ins = s.kind === "insert" ? s : next;
      used.add(s.id);
      used.add(next.id);
      out.push({
        id: `${del.id}+${ins.id}`,
        kind: "suggestion",
        author: s.author,
        createdAt: Math.min(s.createdAt, next.createdAt),
        anchorFrom: Math.min(del.from, ins.from),
        anchorTo: Math.max(del.to, ins.to),
        changeText: content.slice(ins.from, ins.to),
        replacedText: content.slice(del.from, del.to),
        groupedIds: [del.id, ins.id],
      });
      continue;
    }
    out.push({
      id: s.id,
      kind: "suggestion",
      author: s.author,
      createdAt: s.createdAt,
      anchorFrom: s.from,
      anchorTo: s.to,
      changeKind: s.kind,
      changeText: content.slice(s.from, s.to),
      replies: s.replies,
    });
  }
  return out;
}

// A shared-doc comment thread arrives already resolved to absolute
// offsets (listResolvedCommentThreads drops any whose anchor is gone),
// so there's no relocateAnchor / orphan case here.
function commentCard(thread: ResolvedCommentThread): RailAnnotation {
  return {
    id: thread.id,
    kind: "comment",
    author: thread.replies[0]?.author ?? thread.author,
    createdAt: thread.replies[0]?.createdAt ?? thread.createdAt,
    anchorFrom: thread.from,
    anchorTo: thread.to,
    quote: thread.quote,
    resolved: thread.resolved,
    orphaned: false,
    replies: thread.replies,
  };
}

function bySortKey(a: RailAnnotation, b: RailAnnotation): number {
  return a.anchorFrom - b.anchorFrom || a.createdAt - b.createdAt;
}

export function railAnnotationsForShared(suggestions: ResolvedSuggestion[], threads: ResolvedCommentThread[], content: string): RailAnnotation[] {
  return [...suggestionCards(suggestions, content), ...threads.map(commentCard)].sort(bySortKey);
}

export function railAnnotationsForLocal(notes: Note[], content: string): RailAnnotation[] {
  return notes
    .map((n): RailAnnotation => {
      const loc = relocateAnchor(content, n);
      return {
        id: n.id,
        kind: "comment",
        author: "", // local notes carry no author
        createdAt: n.createdAt,
        anchorFrom: loc?.from ?? 0,
        anchorTo: loc?.to ?? 0,
        quote: n.quote,
        orphaned: !loc,
        replies: [{ id: n.id, author: "", body: n.body, createdAt: n.createdAt }],
      };
    })
    .sort(bySortKey);
}
