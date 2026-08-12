import { describe, it, expect } from "vitest";
import { generateMermaid, removeNode, type FlowchartModel } from "./flowchart-model";

function model(overrides: Partial<FlowchartModel> = {}): FlowchartModel {
  return { direction: "TD", nodes: [], edges: [], subgraphs: [], ...overrides };
}

describe("generateMermaid", () => {
  it("returns just the flowchart header for an empty model", () => {
    expect(generateMermaid(model())).toBe("flowchart TD");
  });

  it("uses the model's direction", () => {
    expect(generateMermaid(model({ direction: "LR" }))).toBe("flowchart LR");
  });

  it("declares a rectangle node", () => {
    const m = model({ nodes: [{ id: "n1", label: "Start", shape: "rectangle" }] });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1["Start"]');
  });

  it("declares a rounded node", () => {
    const m = model({ nodes: [{ id: "n1", label: "Start", shape: "rounded" }] });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1("Start")');
  });

  it("declares a diamond node", () => {
    const m = model({ nodes: [{ id: "n1", label: "Working?", shape: "diamond" }] });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1{"Working?"}');
  });

  it("escapes a double quote in a node label", () => {
    const m = model({ nodes: [{ id: "n1", label: 'Say "hi"', shape: "rectangle" }] });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1["Say #quot;hi#quot;"]');
  });

  it("declares a solid edge with no label", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", style: "solid" }],
    });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1["A"]\nn2["B"]\nn1 --> n2');
  });

  it("declares a labeled solid edge", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", label: "Yes", style: "solid" }],
    });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1["A"]\nn2["B"]\nn1 -->|Yes| n2');
  });

  it("declares a dotted edge", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", style: "dotted" }],
    });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1["A"]\nn2["B"]\nn1 -.-> n2');
  });

  it("declares a labeled dotted edge, and escapes a quote in the edge label", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", label: 'the "fast" path', style: "dotted" }],
    });
    expect(generateMermaid(m)).toBe('flowchart TD\nn1["A"]\nn2["B"]\nn1 -.->|the #quot;fast#quot; path| n2');
  });

  it("declares subgraph-member nodes inside the subgraph block, top-level nodes outside", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "In group", shape: "rectangle" },
        { id: "n2", label: "Top level", shape: "rectangle" },
      ],
      subgraphs: [{ id: "sg1", label: "Group A", nodeIds: ["n1"] }],
    });
    expect(generateMermaid(m)).toBe(
      'flowchart TD\nsubgraph sg1["Group A"]\n  n1["In group"]\nend\nn2["Top level"]'
    );
  });

  it("emits edges after all subgraph and top-level node declarations", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "In group", shape: "rectangle" },
        { id: "n2", label: "Top level", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", style: "solid" }],
      subgraphs: [{ id: "sg1", label: "Group A", nodeIds: ["n1"] }],
    });
    expect(generateMermaid(m)).toBe(
      'flowchart TD\nsubgraph sg1["Group A"]\n  n1["In group"]\nend\nn2["Top level"]\nn1 --> n2'
    );
  });
});

describe("removeNode", () => {
  it("removes the node itself", () => {
    const m = model({ nodes: [{ id: "n1", label: "A", shape: "rectangle" }] });
    expect(removeNode(m, "n1").nodes).toEqual([]);
  });

  it("leaves other nodes untouched", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
      ],
    });
    expect(removeNode(m, "n1").nodes).toEqual([{ id: "n2", label: "B", shape: "rectangle" }]);
  });

  it("removes edges where the node is the source", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", style: "solid" }],
    });
    expect(removeNode(m, "n1").edges).toEqual([]);
  });

  it("removes edges where the node is the target", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2", style: "solid" }],
    });
    expect(removeNode(m, "n2").edges).toEqual([]);
  });

  it("leaves edges not touching the removed node untouched", () => {
    const m = model({
      nodes: [
        { id: "n1", label: "A", shape: "rectangle" },
        { id: "n2", label: "B", shape: "rectangle" },
        { id: "n3", label: "C", shape: "rectangle" },
      ],
      edges: [{ id: "e1", fromNodeId: "n2", toNodeId: "n3", style: "solid" }],
    });
    expect(removeNode(m, "n1").edges).toEqual([{ id: "e1", fromNodeId: "n2", toNodeId: "n3", style: "solid" }]);
  });

  it("removes the node from every subgraph's membership", () => {
    const m = model({
      nodes: [{ id: "n1", label: "A", shape: "rectangle" }],
      subgraphs: [{ id: "sg1", label: "Group", nodeIds: ["n1"] }],
    });
    expect(removeNode(m, "n1").subgraphs).toEqual([{ id: "sg1", label: "Group", nodeIds: [] }]);
  });
});
