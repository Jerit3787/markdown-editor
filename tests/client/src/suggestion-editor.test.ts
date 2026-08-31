// @vitest-environment jsdom
// EditorView needs a real `document` global (constructing/dispatching
// against it in suggestionExtensions' tests below) — the default node
// environment doesn't provide one, same reasoning as collab.test.ts's
// own environment docblock.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as awarenessProtocol from "y-protocols/awareness";
import { recordInsertSuggestion, recordDeleteSuggestion, listResolvedSuggestions } from "../../../src/suggestions";
import { suggestionDecorations, suggestionExtensions, suggestionWidgetFor } from "../../../client/src/suggestion-editor";

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

function viewFor(doc: Y.Doc, author: string): EditorView {
  const ytext = doc.getText("content");
  const awareness = new awarenessProtocol.Awareness(doc);
  return new EditorView({
    doc: ytext.toString(),
    extensions: [yCollab(ytext, awareness), ...suggestionExtensions(doc, author, { viewerRole: "reviewer", viewerName: author })],
  });
}

describe("suggestionExtensions", () => {
  it("typing creates an insert suggestion instead of a plain edit", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 5, insert: "!" } });

    expect(doc.getText("content").toString()).toBe("hello! world");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "alice", from: 5, to: 6 });
    view.destroy();
  });

  it("typing two characters in a row extends one suggestion, not two", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 11, insert: "!" } });
    view.dispatch({ changes: { from: 12, insert: "!" } });

    expect(listResolvedSuggestions(doc)).toHaveLength(1);
    expect(listResolvedSuggestions(doc)[0]).toMatchObject({ from: 11, to: 13 });
    view.destroy();
  });

  it("deleting blocks the removal and records a delete suggestion instead", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 0, to: 5 } }); // delete "hello"

    expect(doc.getText("content").toString()).toBe("hello world"); // unchanged
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "delete", author: "alice", from: 0, to: 5 });
    view.destroy();
  });

  it("replacing a selection by typing suggests deleting the old text and inserting the new text", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 0, to: 5, insert: "goodbye" } }); // select "hello", type "goodbye"

    expect(doc.getText("content").toString()).not.toBe("goodbye world"); // old text still present somewhere
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.kind === "delete")).toMatchObject({ from: 0, to: 5 });
    const insert = list.find((s) => s.kind === "insert")!;
    expect(doc.getText("content").toString().slice(insert.from, insert.to)).toBe("goodbye");
    view.destroy();
  });

  it("does not intercept a remote Yjs update applied through yCollab", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
    remoteDoc.getText("content").insert(0, "REMOTE ");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc));

    // A remote change must land as plain content, never as a local
    // suggestion attributed to "alice" (the local reviewer didn't type it).
    expect(doc.getText("content").toString()).toBe("REMOTE hello world");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
    view.destroy();
  });
});

describe("suggestionWidgetFor", () => {
  it("renders an insert suggestion's author and an accept/reject pair for an editor", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "editor", viewerName: "carol" }).toDOM();
    expect(el.textContent).toContain("alice");
    expect(el.querySelector("[data-action='accept']")).not.toBeNull();
    expect(el.querySelector("[data-action='reject']")).not.toBeNull();
    expect(el.querySelector("[data-action='withdraw']")).toBeNull();
  });

  it("renders only a withdraw action for the suggestion's own author", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "reviewer", viewerName: "alice" }).toDOM();
    expect(el.querySelector("[data-action='withdraw']")).not.toBeNull();
    expect(el.querySelector("[data-action='accept']")).toBeNull();
  });

  it("renders read-only info for a different reviewer", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "reviewer", viewerName: "bob" }).toDOM();
    expect(el.querySelector("[data-action]")).toBeNull();
  });

  it("clicking accept resolves the suggestion", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "editor", viewerName: "carol" }).toDOM();
    (el.querySelector("[data-action='accept']") as HTMLButtonElement).click();
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
    expect(doc.getText("content").toString()).toBe("hello world");
  });
});
