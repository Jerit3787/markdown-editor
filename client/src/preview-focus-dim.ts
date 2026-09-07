// B2 — in focus mode, dims every top-level preview block that isn't part
// of the paragraph the cursor is in, mirroring the editor's own
// .cm-dimmed-line treatment.
//
// `children` are #preview's direct children, already tagged with a 0-based
// `data-line` source-line start by updatePreview() (computeBlockLineStarts,
// same tags scroll-sync keys off). `active` is the 1-based inclusive line
// range published by Editor.svelte on the focusActiveLines store; null
// clears all dimming (focus mode off).
//
// A block spans [its data-line, the next tagged block's data-line); it
// stays undimmed when that span overlaps the active paragraph. Blocks with
// no data-line (e.g. the trailing footnotes section) are never dimmed.
export function applyFocusDim(children: readonly Element[], active: { from: number; to: number } | null): void {
  if (!active) {
    for (const el of children) el.classList.remove("focus-dim");
    return;
  }
  const from0 = active.from - 1;
  const to0 = active.to - 1;
  const lineOf = (el: Element): number | null => (el.hasAttribute("data-line") ? Number(el.getAttribute("data-line")) : null);

  for (let i = 0; i < children.length; i++) {
    const line = lineOf(children[i]);
    if (line === null) {
      children[i].classList.remove("focus-dim");
      continue;
    }
    let end = Infinity;
    for (let j = i + 1; j < children.length; j++) {
      const next = lineOf(children[j]);
      if (next !== null) {
        end = next;
        break;
      }
    }
    const overlaps = line <= to0 && end > from0;
    children[i].classList.toggle("focus-dim", !overlaps);
  }
}
