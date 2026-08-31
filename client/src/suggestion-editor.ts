import * as Y from "yjs";
import { EditorState, StateField, type Extension, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";
import {
  listResolvedSuggestions,
  recordInsertSuggestion,
  recordDeleteSuggestion,
  resolveSuggestion,
  withdrawSuggestion,
  getSuggestionsMap,
  type ResolvedSuggestion,
} from "./suggestions";

export const suggestionInsertMark = Decoration.mark({ class: "cm-suggestion-insert" });
export const suggestionDeleteMark = Decoration.mark({ class: "cm-suggestion-delete" });

class SuggestionWidget extends WidgetType {
  constructor(
    private doc: Y.Doc,
    private suggestion: ResolvedSuggestion,
    private viewer: { viewerRole: string; viewerName: string },
  ) {
    super();
  }

  eq(other: SuggestionWidget): boolean {
    return other.suggestion.id === this.suggestion.id;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-suggestion-card";
    const label = document.createElement("span");
    label.className = "cm-suggestion-author";
    label.textContent = `${this.suggestion.author} suggested ${this.suggestion.kind === "insert" ? "adding" : "removing"} this`;
    el.appendChild(label);

    const isOwnSuggestion = this.viewer.viewerName === this.suggestion.author;
    const isEditor = this.viewer.viewerRole === "editor";

    if (isEditor) {
      el.appendChild(this.actionButton("accept", "✓", () => resolveSuggestion(this.doc, this.suggestion.id, "accept")));
      el.appendChild(this.actionButton("reject", "✗", () => resolveSuggestion(this.doc, this.suggestion.id, "reject")));
    } else if (isOwnSuggestion) {
      el.appendChild(this.actionButton("withdraw", "Withdraw", () => withdrawSuggestion(this.doc, this.suggestion.id)));
    }
    return el;
  }

  private actionButton(action: string, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.action = action;
    btn.className = "cm-suggestion-action";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }
}

export function suggestionWidgetFor(doc: Y.Doc, suggestion: ResolvedSuggestion, viewer: { viewerRole: string; viewerName: string }): SuggestionWidget {
  return new SuggestionWidget(doc, suggestion, viewer);
}

// Pure: derives the full decoration set from the Y.Doc's current
// suggestions, plus an inline widget at the end of each range carrying
// the accept/reject/withdraw actions appropriate to who's looking.
// Wrapped in a live-updating StateField (suggestionExtensions below) —
// kept separate here so this core mapping logic is testable without a
// live EditorView.
export function suggestionDecorations(state: EditorState, doc: Y.Doc, viewer: { viewerRole: string; viewerName: string }): DecorationSet {
  const list = listResolvedSuggestions(doc); // already sorted by `from`
  const ranges = list
    .filter((s) => s.to > s.from && s.to <= state.doc.length)
    .flatMap((s) => [
      (s.kind === "insert" ? suggestionInsertMark : suggestionDeleteMark).range(s.from, s.to),
      Decoration.widget({ widget: suggestionWidgetFor(doc, s, viewer), side: 1 }).range(s.to),
    ]);
  return Decoration.set(ranges, true); // `true`: sort for us — mark + widget ranges interleaved aren't guaranteed pre-sorted
}

// Reviewer-only edit interception: insertions apply to ytext normally
// (via yCollab, unblocked below) and get a suggestion entry recorded
// after the fact; deletions never reach ytext at all — the deletion half
// of the transaction is dropped and a delete-suggestion is recorded
// instead. A transaction that both deletes a selection and inserts
// replacement text (typing over a selection) becomes: block the delete,
// keep the insert but re-target it to land immediately AFTER the
// (still-present) deleted range instead of where it would have
// overwritten it — so "replace" always reads as "old text struck
// through, followed by new text underlined," the same representation
// Google Docs itself uses for a suggested replacement.
function suggestionTransactionFilter(doc: Y.Doc, author: () => string) {
  return EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr;
    if (tr.annotation(ySyncAnnotation) !== undefined) return tr; // a remote change yCollab is applying locally — never intercept

    let deletedFrom = -1;
    let deletedTo = -1;
    let insertedText = "";
    let insertedAt = -1;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (toA > fromA) {
        deletedFrom = fromA;
        deletedTo = toA;
      }
      if (inserted.length > 0) {
        insertedText = inserted.toString();
        insertedAt = fromA;
      }
    });

    if (deletedFrom === -1) return tr; // pure insert (or no-op) — let it apply as-is; recordInsertSuggestion runs from the updateListener below
    void insertedAt;

    // A deletion is involved — never let it reach the document. If there
    // was also an insertion in the same transaction (a selection
    // replace), re-target it to land right after the deleted range
    // instead, on top of the UNCHANGED original document.
    recordDeleteSuggestion(doc, deletedFrom, deletedTo, author());
    if (insertedText === "") return []; // pure delete — cancel the whole transaction
    return {
      changes: { from: deletedTo, to: deletedTo, insert: insertedText },
      selection: { anchor: deletedTo + insertedText.length },
    };
  });
}

// Records the plain-insert case (no deletion involved) once the
// transaction has actually applied — reading the final positions off
// `update.changes` after the fact is simpler and just as correct as
// computing them in the filter above, since a pure insert is never
// re-targeted.
function suggestionInsertListener(doc: Y.Doc, author: () => string) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some((tr) => tr.annotation(ySyncAnnotation) !== undefined)) return;
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (toA > fromA || inserted.length === 0) return; // a deletion is handled entirely by the filter above, not here
      recordInsertSuggestion(doc, fromB, toB, author());
    });
  });
}

// Live-updating decoration field: recomputed on every transaction (cheap —
// listResolvedSuggestions is O(number of pending suggestions), never
// O(document size)) plus whenever the Yjs suggestions map changes
// remotely (an editor's accept/reject, or another reviewer's own pending
// edit arriving).
export function suggestionDecorationField(doc: Y.Doc, viewer: { viewerRole: string; viewerName: string }): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => suggestionDecorations(state, doc, viewer),
    update: (_value, tr) => suggestionDecorations(tr.state, doc, viewer),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    ViewPlugin.fromClass(
      class {
        private unsubscribe: () => void;
        constructor(view: EditorView) {
          const map = getSuggestionsMap(doc);
          // Deferred to a microtask, not called synchronously: this
          // observer can fire from INSIDE an already-in-progress dispatch
          // (recordInsertSuggestion/recordDeleteSuggestion, called from
          // suggestionInsertListener/suggestionTransactionFilter below,
          // both run as part of handling a local edit's own transaction —
          // their Y.Map write fires this observer synchronously, before
          // that outer dispatch has finished). Calling view.dispatch({})
          // synchronously in that situation is a reentrant dispatch CM6
          // doesn't support (confirmed live: "Trying to update state with
          // a transaction that doesn't start from the previous state").
          // The outer transaction's own StateField.update already
          // recomputes decorations using the state current when the
          // transaction started; this microtask-deferred extra dispatch
          // is what catches the map change that transaction itself just
          // made, plus any genuinely-external change (a remote accept/
          // reject, another reviewer's own edit).
          const onMapChange = () => queueMicrotask(() => view.dispatch({}));
          map.observe(onMapChange);
          this.unsubscribe = () => map.unobserve(onMapChange);
        }
        destroy() {
          this.unsubscribe();
        }
      },
    ),
  ];
}

// suggestionDecorationField (above) is needed by BOTH a reviewer and an
// editor — an editor must see and be able to act on suggestions in their
// own editor surface too, not just the reviewer who made them. The
// edit-interception pieces must NEVER apply to an editor's own direct
// edits, so they're gated on viewerRole here rather than left to the
// caller to decide.
export function suggestionExtensions(doc: Y.Doc, author: string, viewer: { viewerRole: string; viewerName: string }): Extension[] {
  const extensions: Extension[] = [suggestionDecorationField(doc, viewer)];
  if (viewer.viewerRole === "reviewer") {
    extensions.push(
      suggestionTransactionFilter(doc, () => author),
      suggestionInsertListener(doc, () => author),
    );
  }
  return extensions;
}
