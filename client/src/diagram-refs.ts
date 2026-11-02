// "diagram", "diagram-2", "diagram-3", ... — mirrors app.ts's imageKey()
// de-duplication, but with no source filename to seed a base name from,
// so the base is always literally "diagram".
export function diagramKey(diagrams: Record<string, string>): string {
  let key = "diagram";
  let n = 2;
  while (diagrams[key]) {
    key = `diagram-${n}`;
    n++;
  }
  return key;
}

// Mirrors app.ts's resolveImageRefs(): substitutes a ref-only fence back
// into a real, portable ```mermaid block for export/publish. A ref key is
// always a single line (see diagramKey), so the fence's content is
// captured as one line, not multiline source.
export function resolveDiagramRefs(text: string, diagrams: Record<string, string> | undefined): string {
  if (!diagrams) return text;
  return text.replace(/```mermaid[ \t]*\n([^\n]*)\n```/g, (match, ref) => {
    // The preview renderer looks the key up via code.trim(); a hand-
    // written/pasted fence with trailing whitespace must resolve the same
    // way here, or export/publish leaves a literal one-line ref fence.
    const source = diagrams[ref.trim()];
    return source ? `\`\`\`mermaid\n${source}\n\`\`\`` : match;
  });
}
