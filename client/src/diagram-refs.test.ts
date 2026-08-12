import { describe, it, expect } from "vitest";
import { diagramKey, resolveDiagramRefs } from "./diagram-refs";

describe("diagramKey", () => {
  it("returns 'diagram' when the map is empty", () => {
    expect(diagramKey({})).toBe("diagram");
  });

  it("returns 'diagram-2' when 'diagram' is taken", () => {
    expect(diagramKey({ diagram: "flowchart TD" })).toBe("diagram-2");
  });

  it("returns 'diagram-3' when 'diagram' and 'diagram-2' are both taken", () => {
    expect(diagramKey({ diagram: "a", "diagram-2": "b" })).toBe("diagram-3");
  });
});

describe("resolveDiagramRefs", () => {
  it("resolves a known ref to its stored source", () => {
    const text = '# Title\n\n```mermaid\ndiagram\n```\n';
    const diagrams = { diagram: "flowchart TD\nA-->B" };
    expect(resolveDiagramRefs(text, diagrams)).toBe(
      '# Title\n\n```mermaid\nflowchart TD\nA-->B\n```\n'
    );
  });

  it("leaves an unknown ref untouched", () => {
    const text = '```mermaid\nnotAKnownRef\n```\n';
    expect(resolveDiagramRefs(text, { diagram: "flowchart TD" })).toBe(text);
  });

  it("returns the text unchanged when diagrams is undefined", () => {
    const text = '```mermaid\ndiagram\n```\n';
    expect(resolveDiagramRefs(text, undefined)).toBe(text);
  });

  it("resolves multiple diagrams in the same document independently", () => {
    const text = '```mermaid\na\n```\n\ntext\n\n```mermaid\nb\n```\n';
    const diagrams = { a: "flowchart TD\nX-->Y", b: "flowchart LR\nP-->Q" };
    expect(resolveDiagramRefs(text, diagrams)).toBe(
      '```mermaid\nflowchart TD\nX-->Y\n```\n\ntext\n\n```mermaid\nflowchart LR\nP-->Q\n```\n'
    );
  });

  it("leaves text with no mermaid fences unchanged", () => {
    const text = "# Just a heading\n\nSome text.\n";
    expect(resolveDiagramRefs(text, { diagram: "flowchart TD" })).toBe(text);
  });
});
