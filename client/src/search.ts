import { search, SearchQuery, getSearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

interface MatchRange {
  from: number;
  to: number;
}

function collectMatchRanges(state: EditorState, query: SearchQuery): MatchRange[] {
  if (!query.valid) return [];
  const ranges: MatchRange[] = [];
  const cursor = query.getCursor(state.doc);
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    ranges.push({ from: result.value.from, to: result.value.to });
  }
  return ranges;
}

// Live match count for FindReplaceBar's "n of m" indicator: the match at
// or after the current selection head, wrapping to the first match if
// the selection is past every one of them — matches findNext's own
// wrap-around behavior. `index` is 0 when `total` is 0.
export function countMatches(state: EditorState, query: SearchQuery): { total: number; index: number } {
  const ranges = collectMatchRanges(state, query);
  if (ranges.length === 0) return { total: 0, index: 0 };
  const head = state.selection.main.head;
  const at = ranges.findIndex((r) => r.to >= head);
  return { total: ranges.length, index: at === -1 ? 1 : at + 1 };
}

// @codemirror/search's own built-in match highlighter only ever paints
// decorations while its default search panel is open (checked directly
// in its source: `if (!panel || !query.spec.valid) return Decoration.none`)
// — FindReplaceBar.svelte never opens that panel, so this needs its own
// highlight field instead. Reuses @codemirror/search's own
// "cm-searchMatch"/"cm-searchMatch-selected" class names, already styled
// (light and dark) by the baseTheme search() itself installs below, so
// no new CSS is needed here.
const matchMark = Decoration.mark({ class: "cm-searchMatch" });
const selectedMatchMark = Decoration.mark({ class: "cm-searchMatch-selected" });

function computeMatchHighlights(state: EditorState): DecorationSet {
  const ranges = collectMatchRanges(state, getSearchQuery(state));
  if (ranges.length === 0) return Decoration.none;
  return Decoration.set(
    ranges.map((r) => {
      const selected = state.selection.ranges.some((sel) => sel.from === r.from && sel.to === r.to);
      return (selected ? selectedMatchMark : matchMark).range(r.from, r.to);
    }),
  );
}

const searchHighlightField = StateField.define<DecorationSet>({
  create: (state) => computeMatchHighlights(state),
  update(deco, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.some((e) => e.is(setSearchQuery))) return deco;
    return computeMatchHighlights(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function buildSearchExtension(): Extension {
  return [search(), searchHighlightField];
}
