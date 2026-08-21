import { StreamLanguage, HighlightStyle, type StringStream } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export type MermaidDiagramType = "flowchart" | "sequence" | "class" | "state" | "er" | "gantt" | "pie";

const TYPE_PATTERNS: [RegExp, MermaidDiagramType][] = [
  [/^(flowchart|graph)\b/, "flowchart"],
  [/^sequenceDiagram\b/, "sequence"],
  [/^classDiagram\b/, "class"],
  [/^stateDiagram(-v2)?\b/, "state"],
  [/^erDiagram\b/, "er"],
  [/^gantt\b/, "gantt"],
  [/^pie\b/, "pie"],
];

export function detectDiagramType(text: string): MermaidDiagramType | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    for (const [pattern, type] of TYPE_PATTERNS) {
      if (pattern.test(line)) return type;
    }
    return null; // first real content line didn't match any known type
  }
  return null;
}

const KEYWORDS_BY_TYPE: Record<MermaidDiagramType, string[]> = {
  flowchart: ["flowchart", "graph", "subgraph", "end", "TD", "TB", "LR", "RL", "BT"],
  sequence: [
    "sequenceDiagram",
    "participant",
    "actor",
    "loop",
    "alt",
    "opt",
    "par",
    "and",
    "else",
    "end",
    "activate",
    "deactivate",
    "Note",
    "over",
    "left",
    "right",
    "of",
  ],
  class: ["classDiagram", "class", "interface"],
  state: ["stateDiagram", "stateDiagram-v2", "state"],
  er: ["erDiagram"],
  gantt: ["gantt", "title", "dateFormat", "section", "excludes"],
  pie: ["pie", "title"],
};

const OPERATORS_BY_TYPE: Record<MermaidDiagramType, RegExp> = {
  flowchart: /^(-->|-\.->|==>|--x|--o|-\.-|---)/,
  sequence: /^(-->>|->>|--\)|-\)|--x|-x|-->|->)/,
  class: /^(<\|--|--\|>|\*--|--\*|o--|--o|\.\.\|>|<\|\.\.|\.\.>|<\.\.|-->|<--|--|\.\.)/,
  state: /^(-->)/,
  er: /^[|o}{.-]{2,}/,
  gantt: /^:/,
  pie: /^:/,
};

interface ModeState {
  diagramType: MermaidDiagramType | null;
  checkedType: boolean;
}

function token(stream: StringStream, state: ModeState): string | null {
  // The diagram-type declaration is always the document's first
  // non-comment line — this only ever runs once per fresh parse (state
  // starts fresh at position 0 of line 1), so it's safe to gate on a
  // "have I checked yet" flag rather than tracking line numbers.
  if (!state.checkedType) {
    state.checkedType = true;
    const line = stream.string.trim();
    for (const [pattern, type] of TYPE_PATTERNS) {
      if (pattern.test(line)) {
        state.diagramType = type;
        break;
      }
    }
  }

  if (stream.match(/^%%.*/)) return "comment";
  if (stream.match(/^"([^"\\]|\\.)*"/) || stream.match(/^'([^'\\]|\\.)*'/)) return "string";
  if (stream.match(/^-?\d+(\.\d+)?/)) return "number";

  const type = state.diagramType;
  if (type) {
    const keywordPattern = new RegExp(`^(${KEYWORDS_BY_TYPE[type].join("|")})\\b`);
    if (stream.match(keywordPattern)) return "keyword";
    if (stream.match(OPERATORS_BY_TYPE[type])) return "operator";
  }

  if (stream.match(/^\[\*\]/)) return "atom"; // state diagram start/end marker
  if (stream.eat(/[[\](){}]/)) return "bracket";

  stream.next();
  return null;
}

export const mermaidStreamLanguage = StreamLanguage.define<ModeState>({
  startState: () => ({ diagramType: null, checkedType: false }),
  token,
});

export const mermaidHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--accent)", fontWeight: "600" },
  { tag: t.comment, color: "var(--text-dim)", fontStyle: "italic" },
  { tag: t.string, color: "var(--accent)" },
  { tag: t.number, color: "var(--text)" },
  { tag: t.operator, color: "var(--text-dim)" },
  { tag: t.bracket, color: "var(--text-dim)" },
  { tag: t.atom, color: "var(--accent)", fontWeight: "600" },
]);
