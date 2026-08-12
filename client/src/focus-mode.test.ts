import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { activeParagraphRange } from "./focus-mode";

describe("activeParagraphRange", () => {
  it("returns the whole document when it's a single paragraph", () => {
    const doc = Text.of(["one", "two", "three"]);
    const range = activeParagraphRange(doc, 0);
    expect(range).toEqual({ from: 0, to: doc.length });
  });

  it("finds the paragraph containing the cursor, separated by a blank line", () => {
    const doc = Text.of(["first para", "", "second para line 1", "second para line 2", "", "third"]);
    const line3 = doc.line(3); // "second para line 1"
    const range = activeParagraphRange(doc, line3.from);
    const line4 = doc.line(4); // "second para line 2"
    expect(range).toEqual({ from: line3.from, to: line4.to });
  });

  it("cursor on the first line of a multi-line paragraph still spans the whole paragraph", () => {
    const doc = Text.of(["para line 1", "para line 2", "para line 3"]);
    const range = activeParagraphRange(doc, doc.line(1).from);
    expect(range).toEqual({ from: doc.line(1).from, to: doc.line(3).to });
  });

  it("cursor on the last line of a multi-line paragraph still spans the whole paragraph", () => {
    const doc = Text.of(["para line 1", "para line 2", "para line 3"]);
    const range = activeParagraphRange(doc, doc.line(3).from);
    expect(range).toEqual({ from: doc.line(1).from, to: doc.line(3).to });
  });

  it("cursor on a blank line between paragraphs returns just that blank line", () => {
    const doc = Text.of(["first", "", "second"]);
    const blankLine = doc.line(2);
    const range = activeParagraphRange(doc, blankLine.from);
    expect(range).toEqual({ from: blankLine.from, to: blankLine.to });
  });

  it("handles an empty document", () => {
    const doc = Text.of([""]);
    const range = activeParagraphRange(doc, 0);
    expect(range).toEqual({ from: 0, to: 0 });
  });

  it("cursor in the first paragraph of a multi-paragraph doc (no preceding blank line to stop at)", () => {
    const doc = Text.of(["first", "", "second"]);
    const range = activeParagraphRange(doc, 2);
    expect(range).toEqual({ from: 0, to: doc.line(1).to });
  });

  it("cursor in the last paragraph of a multi-paragraph doc (no following blank line to stop at)", () => {
    const doc = Text.of(["first", "", "second"]);
    const line3 = doc.line(3);
    const range = activeParagraphRange(doc, line3.from);
    expect(range).toEqual({ from: line3.from, to: doc.length });
  });
});
