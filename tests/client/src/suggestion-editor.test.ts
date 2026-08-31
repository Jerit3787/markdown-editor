import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { recordInsertSuggestion, recordDeleteSuggestion } from "../../../src/suggestions";
import { suggestionDecorations } from "../../../client/src/suggestion-editor";

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

const VIEWER_EDITOR = { viewerRole: "editor", viewerName: "carol" };

describe("suggestionDecorations", () => {
  it("returns no decorations when there are no suggestions", () => {
    const doc = docWith("hello world");
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    expect(suggestionDecorations(state, doc, VIEWER_EDITOR).size).toBe(0);
  });

  it("marks an insert suggestion's range", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    const decos = suggestionDecorations(state, doc, VIEWER_EDITOR);
    const found: { from: number; to: number; class: string }[] = [];
    decos.between(0, state.doc.length, (from, to, deco) => {
      const spec = deco.spec as { class?: string };
      if (spec.class) found.push({ from, to, class: spec.class });
    });
    expect(found).toEqual([{ from: 5, to: 11, class: "cm-suggestion-insert" }]);
  });

  it("marks a delete suggestion's range with the delete class", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 5, "alice");
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    const decos = suggestionDecorations(state, doc, VIEWER_EDITOR);
    const found: { from: number; to: number; class: string }[] = [];
    decos.between(0, state.doc.length, (from, to, deco) => {
      const spec = deco.spec as { class?: string };
      if (spec.class) found.push({ from, to, class: spec.class });
    });
    expect(found).toEqual([{ from: 0, to: 5, class: "cm-suggestion-delete" }]);
  });

  it("orders multiple decorations by position, required by CodeMirror's Decoration.set", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 6, 11, "alice"); // "world" — created second
    recordInsertSuggestion(doc, 0, 5, "bob"); // "hello" — but starts earlier
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    expect(() => suggestionDecorations(state, doc, VIEWER_EDITOR)).not.toThrow();
  });
});
