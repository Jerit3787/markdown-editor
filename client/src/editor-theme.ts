// Pure, zero-coupling editor styling — no reference to anything else in
// app.ts's closure, so there's no reason to route these through the
// window.MDE bridge. Verbatim move from app.ts (previously lines 337-370).
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--bg)", height: "100%" },
  // Equal top/side padding matching #preview's own 40px, for visual
  // balance between the two panes; bottom kept small (not also 40px) —
  // a full 40px bottom padding left a gap at the editor's true scroll
  // end large enough to visibly desync from the preview's own end.
  // Scoped to only this editor instance via this theme extension
  // (not a global `.cm-content` CSS rule) — DiagramEditor.svelte builds
  // a separate CodeMirror instance with its own extensions and never
  // includes this theme, so a global rule would have (and previously
  // did) leak 40px of padding into that unrelated, much smaller editor.
  ".cm-content": { fontFamily: "var(--mono)", fontSize: "14.5px", lineHeight: "1.6", padding: "40px 40px 4px 40px", caretColor: "var(--text)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-dim) !important" },
  ".cm-image-uploading": { opacity: "0.6", fontStyle: "italic" },
  ".cm-dimmed-line": { opacity: "0.35", transition: "opacity 0.2s ease" },
  ".cm-comment-marker": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)", borderBottom: "2px solid var(--accent)" },
});

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.3em", color: "var(--text)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.15em", color: "var(--text)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--text)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.quote, color: "var(--text-dim)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent)" },
  { tag: [t.meta, t.processingInstruction, t.contentSeparator], color: "var(--text-dim)" },
]);
