import type { Text } from "@codemirror/state";

// Finds the blank-line-delimited paragraph containing `pos` — a plain
// scan on doc.line(), not a markdown-block parse (unlike scroll-sync.ts's
// computeBlockLineStarts(), this only needs "the chunk of non-blank
// lines around the cursor," which blank-line scanning gives directly).
export function activeParagraphRange(doc: Text, pos: number): { from: number; to: number } {
  const line = doc.lineAt(pos);
  // A blank line is a separator between paragraphs, not part of either
  // one — its own "paragraph" is just itself, so scanning must stop
  // immediately rather than merging into a neighboring paragraph.
  if (line.text.trim() === "") return { from: line.from, to: line.to };
  let startLn = line.number;
  while (startLn > 1 && doc.line(startLn - 1).text.trim() !== "") startLn--;
  let endLn = line.number;
  while (endLn < doc.lines && doc.line(endLn + 1).text.trim() !== "") endLn++;
  return { from: doc.line(startLn).from, to: doc.line(endLn).to };
}

// Same paragraph, expressed as an inclusive 1-based line range instead of
// character offsets — what Editor.svelte publishes to the focusActiveLines
// store for Preview.svelte's preview-pane dimming (B2).
export function activeParagraphLineRange(doc: Text, pos: number): { from: number; to: number } {
  const { from, to } = activeParagraphRange(doc, pos);
  return { from: doc.lineAt(from).number, to: doc.lineAt(to).number };
}
