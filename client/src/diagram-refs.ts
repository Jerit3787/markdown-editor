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
    const source = diagrams[ref];
    return source ? `\`\`\`mermaid\n${source}\n\`\`\`` : match;
  });
}
