import { describe, it, expect } from "vitest";
import { detectDiagramType } from "./mermaid-language";

describe("detectDiagramType", () => {
  it("detects a flowchart", () => {
    expect(detectDiagramType("flowchart TD\nA-->B")).toBe("flowchart");
  });

  it("detects the legacy 'graph' flowchart keyword", () => {
    expect(detectDiagramType("graph LR\nA-->B")).toBe("flowchart");
  });

  it("detects a sequence diagram", () => {
    expect(detectDiagramType("sequenceDiagram\nA->>B: hi")).toBe("sequence");
  });

  it("detects a class diagram", () => {
    expect(detectDiagramType("classDiagram\nclass Animal")).toBe("class");
  });

  it("detects a state diagram (v2)", () => {
    expect(detectDiagramType("stateDiagram-v2\n[*] --> Idle")).toBe("state");
  });

  it("detects an ER diagram", () => {
    expect(detectDiagramType("erDiagram\nA ||--o{ B : has")).toBe("er");
  });

  it("detects a gantt chart", () => {
    expect(detectDiagramType("gantt\ntitle Plan")).toBe("gantt");
  });

  it("detects a pie chart", () => {
    expect(detectDiagramType('pie title Results\n"Yes" : 60')).toBe("pie");
  });

  it("skips leading blank lines and comments before detecting the type", () => {
    expect(detectDiagramType("\n%% a comment\n\nflowchart TD\nA-->B")).toBe("flowchart");
  });

  it("returns null for unrecognized content", () => {
    expect(detectDiagramType("not a real diagram type\nsome text")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectDiagramType("")).toBeNull();
  });
});
