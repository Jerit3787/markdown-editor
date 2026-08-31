import * as Y from "yjs";
import type { EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { listResolvedSuggestions } from "./suggestions";

export const suggestionInsertMark = Decoration.mark({ class: "cm-suggestion-insert" });
export const suggestionDeleteMark = Decoration.mark({ class: "cm-suggestion-delete" });

// Pure: derives the full decoration set from the Y.Doc's current
// suggestions. Wrapped in a live-updating StateField (suggestionExtensions
// below) — kept separate here so this core mapping logic is testable
// without a live EditorView. `viewer` (who's looking) doesn't affect which
// ranges get marked, only which actions the accompanying widget offers —
// threaded through now so this signature doesn't change again once the
// widget is added.
export function suggestionDecorations(state: EditorState, doc: Y.Doc, viewer: { viewerRole: string; viewerName: string }): DecorationSet {
  void viewer; // consumed once the widget lands
  const list = listResolvedSuggestions(doc); // already sorted by `from`
  const ranges = list
    .filter((s) => s.to > s.from && s.to <= state.doc.length)
    .map((s) => (s.kind === "insert" ? suggestionInsertMark : suggestionDeleteMark).range(s.from, s.to));
  return Decoration.set(ranges);
}
