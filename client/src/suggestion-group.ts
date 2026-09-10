import { underlyingIds, type RailAnnotation } from "./annotations";

// [start, end) of the source line (\n-delimited) containing `index`.
export function lineRange(content: string, index: number): [number, number] {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const nl = content.indexOf("\n", index);
  return [start, nl === -1 ? content.length : nl];
}

// Merge consecutive suggestion cards that sit on the same source line,
// share an author, and carry no reply thread — a run of >= 2 becomes one
// group card with a `subEdits` row per member. Runs on the output of
// annotations.ts's replace-pair pass, so a replace-pair is one member.
// Comment cards and lone suggestions pass through by reference.
export function groupSuggestionCards(cards: RailAnnotation[], content: string): RailAnnotation[] {
  const out: RailAnnotation[] = [];
  const groupable = (c: RailAnnotation) => c.kind === "suggestion" && (c.replies?.length ?? 0) === 0;
  let i = 0;
  while (i < cards.length) {
    const card = cards[i]!;
    if (!groupable(card)) {
      out.push(card);
      i++;
      continue;
    }
    const [lineFrom, lineTo] = lineRange(content, card.anchorFrom);
    const run: RailAnnotation[] = [card];
    let j = i + 1;
    while (j < cards.length) {
      const next = cards[j]!;
      if (!groupable(next) || next.author !== card.author) break;
      if (next.anchorFrom < lineFrom || next.anchorFrom >= lineTo) break;
      run.push(next);
      j++;
    }
    if (run.length < 2) {
      out.push(card);
      i++;
      continue;
    }
    out.push({
      id: run.map((m) => m.id).join("+"),
      kind: "suggestion",
      author: card.author,
      authorName: card.authorName,
      createdAt: Math.min(...run.map((m) => m.createdAt)),
      anchorFrom: Math.min(...run.map((m) => m.anchorFrom)),
      anchorTo: Math.max(...run.map((m) => m.anchorTo)),
      groupedIds: run.flatMap((m) => underlyingIds(m)),
      subEdits: run.map((m) => ({
        ids: underlyingIds(m),
        kind: m.replacedText != null ? "replace" : (m.changeKind ?? "insert"),
        changeText: m.changeText ?? "",
        replacedText: m.replacedText,
        from: m.anchorFrom,
        to: m.anchorTo,
      })),
    });
    i = j;
  }
  return out;
}
