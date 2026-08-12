export interface FlowchartNode {
  id: string;
  label: string;
  shape: "rectangle" | "rounded" | "diamond";
}

export interface FlowchartEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  style: "solid" | "dotted";
}

export interface FlowchartSubgraph {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface FlowchartModel {
  direction: "TD" | "LR";
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  subgraphs: FlowchartSubgraph[];
}

// Mermaid's own escape for a literal double quote inside a quoted label —
// HTML's &quot; is not recognized there.
function escapeLabel(label: string): string {
  return label.replace(/"/g, "#quot;");
}

function nodeDeclaration(node: FlowchartNode): string {
  const label = escapeLabel(node.label);
  switch (node.shape) {
    case "rectangle": return `${node.id}["${label}"]`;
    case "rounded": return `${node.id}("${label}")`;
    case "diamond": return `${node.id}{"${label}"}`;
  }
}

export function generateMermaid(model: FlowchartModel): string {
  const lines: string[] = [`flowchart ${model.direction}`];
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const subgraphedNodeIds = new Set(model.subgraphs.flatMap((sg) => sg.nodeIds));

  for (const sg of model.subgraphs) {
    lines.push(`subgraph ${sg.id}["${escapeLabel(sg.label)}"]`);
    for (const nodeId of sg.nodeIds) {
      const node = nodeById.get(nodeId);
      if (node) lines.push(`  ${nodeDeclaration(node)}`);
    }
    lines.push("end");
  }

  for (const node of model.nodes) {
    if (!subgraphedNodeIds.has(node.id)) lines.push(nodeDeclaration(node));
  }

  for (const edge of model.edges) {
    const arrow = edge.style === "dotted" ? "-.->" : "-->";
    const labelPart = edge.label ? `|${escapeLabel(edge.label)}|` : "";
    lines.push(`${edge.fromNodeId} ${arrow}${labelPart} ${edge.toNodeId}`);
  }

  return lines.join("\n");
}
