// Pure geometry for the annotation rail: given each card's anchor Y (the
// screen position of the line it annotates, already converted to
// rail-relative pixels by the caller) and its measured height, return the
// `top` each card should render at — collision-resolved so cards never
// overlap, and edge-clamped so a card whose anchor scrolled out of view
// still shows, stacked at the nearest edge. No DOM, no measurement here.

export interface CardAnchor {
  id: string;
  anchorY: number | null; // rail-relative px; null = anchor outside the editor viewport
  direction?: "above" | "below"; // required when anchorY is null
  height: number; // measured card height in px
}

export interface CardPlacement {
  id: string;
  top: number;
  clamped: "top" | "bottom" | null;
}

export function layoutCards(anchors: CardAnchor[], viewport: { height: number }, gap: number): CardPlacement[] {
  const visible = anchors.filter((a): a is CardAnchor & { anchorY: number } => a.anchorY !== null).sort((a, b) => a.anchorY - b.anchorY);
  const above = anchors.filter((a) => a.anchorY === null && a.direction === "above");
  const below = anchors.filter((a) => a.anchorY === null && a.direction === "below");

  const placements: CardPlacement[] = [];

  // Visible: greedy top-down. A card sits at its anchor, or just below
  // the previous card if that would overlap — never above its own anchor.
  // When more cards cluster in the visible region than fit, the stack
  // simply runs past the bottom edge (clipped by the canvas); scrolling
  // the editor brings the lower anchors — and their cards — up. Clawing
  // the stack back up can't preserve both non-overlap and the
  // at-or-below-anchor rule once the heights sum past the viewport, so
  // it isn't attempted. `viewport` is kept in the signature for the
  // off-screen edge stacking below and future tuning.
  let cursor = 0;
  for (const a of visible) {
    const top = Math.max(a.anchorY, cursor);
    placements.push({ id: a.id, top, clamped: null });
    cursor = top + a.height + gap;
  }

  // Off-screen: stack from the near edge, most-recent (last in list) nearest the fold.
  let aTop = 0;
  for (const a of above) {
    placements.push({ id: a.id, top: aTop, clamped: "top" });
    aTop += a.height + gap;
  }
  let bTop = viewport.height;
  for (const a of below) {
    bTop -= a.height;
    placements.push({ id: a.id, top: bTop, clamped: "bottom" });
    bTop -= gap;
  }

  return placements;
}
