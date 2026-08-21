import { linkModalOpen, linkModalPrefillText } from "./stores/linkModal";

export function runCmd(cmd: string) {
  switch (cmd) {
    case "bold":
      return wrapSelection("**", "**", "bold text");
    case "italic":
      return wrapSelection("_", "_", "italic text");
    case "strike":
      return wrapSelection("~~", "~~", "strikethrough");
    case "h1":
      return prefixLine("# ");
    case "h2":
      return prefixLine("## ");
    case "h3":
      return prefixLine("### ");
    case "quote":
      return prefixLine("> ");
    case "code":
      return wrapSelection("`", "`", "code");
    case "codeblock":
      return wrapSelection("```\n", "\n```", "code");
    case "ul":
      return prefixLine("- ");
    case "ol":
      return prefixLine("1. ");
    case "task":
      return prefixLine("- [ ] ");
    case "link":
      return insertLink();
    case "image":
      return insertImage();
    case "table":
      return insertTable();
    case "hr":
      return insertBlock("\n---\n");
    case "math":
      return insertMathSnippet();
    case "footnote":
      return insertFootnoteSnippet();
  }
}

export function wrapSelection(before: string, after: string, placeholder?: string) {
  const view = window.MDE.getEditor();
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to);
  const text = sel || placeholder || "";
  const insert = before + text + after;
  if (!sel && placeholder) {
    // Select just the inserted placeholder so typing immediately
    // replaces it, instead of leaving the cursor after it.
    const selFrom = from + before.length;
    const selTo = selFrom + placeholder.length;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: selFrom, head: selTo } });
  } else {
    view.dispatch(view.state.replaceSelection(insert));
  }
}

export function prefixLine(prefix: string) {
  const view = window.MDE.getEditor();
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (line.text.startsWith(prefix)) {
    view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: "" } });
  } else {
    // Without an explicit selection, an insertion landing exactly at
    // the cursor's position (the common case — an empty line) maps
    // the cursor to stay *before* the inserted text by default,
    // leaving it sitting in front of "# " instead of ready to type
    // after it.
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: line.from, insert: prefix }, selection: { anchor: head + prefix.length } });
  }
}

// A popup instead of dropping raw `[text](https://)` markdown into the
// editor — friendlier for anyone not already fluent in markdown syntax.
export function insertLink() {
  const view = window.MDE.getEditor();
  const { from, to } = view.state.selection.main;
  linkModalPrefillText.set(view.state.sliceDoc(from, to));
  linkModalOpen.set(true);
}

export function insertLinkIntoEditor(text: string, url: string) {
  const view = window.MDE.getEditor();
  view.dispatch(view.state.replaceSelection(`[${text || "link text"}](${url || "https://"})`));
  view.focus();
}

export function insertImage() {
  document.getElementById("imageFileInput").click();
}

export function insertTable() {
  insertBlock("\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |\n");
}

export function insertBlock(block: string) {
  const view = window.MDE.getEditor();
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: block }, selection: { anchor: pos + block.length } });
}

// Inserts a block math snippet with the cursor on the blank line
// between the delimiters, so typing immediately starts the LaTeX
// source — same "insert and place the cursor usefully" shape as
// insertTable()/insertBlock(), just with an interior cursor position
// rather than one trailing the whole insert.
export function insertMathSnippet() {
  const view = window.MDE.getEditor();
  const pos = view.state.selection.main.head;
  const block = "$$\n\n$$";
  const cursorPos = pos + 3; // after "$$\n"
  view.dispatch({ changes: { from: pos, insert: block }, selection: { anchor: cursorPos } });
}

// Inserts a [^N] reference at the cursor and a [^N]: definition at the
// document's end, auto-numbered past any existing numeric footnote
// references — a hand-written named footnote like [^note] is ignored
// by the scan (matches [^(\d+)] only) and never collides with this
// button's own numbering. One atomic transaction (both changes
// dispatched together) — a single undo step, not two.
export function insertFootnoteSnippet() {
  const view = window.MDE.getEditor();
  const text = view.state.doc.toString();
  const existingLabels = [...text.matchAll(/\[\^(\d+)\]/g)].map((m) => parseInt(m[1], 10)).filter((n) => !Number.isNaN(n));
  const nextLabel = existingLabels.length > 0 ? Math.max(...existingLabels) + 1 : 1;
  const pos = view.state.selection.main.head;
  const ref = `[^${nextLabel}]`;
  const def = `\n\n[^${nextLabel}]: `;
  const docEnd = view.state.doc.length;
  view.dispatch({
    changes: [
      { from: pos, insert: ref },
      { from: docEnd, insert: def },
    ],
    selection: { anchor: docEnd + ref.length + def.length },
  });
}

// MenuBar.svelte/CommandPalette.svelte/SlashMenu.svelte/DiagramEditor.svelte
// call these directly — they have no access to this module's functions
// otherwise, same reasoning as every other window.MDE bridge method.
// Toolbar.svelte imports runCmd directly instead (see its own change in
// this task) since it's a plain function in a plain module, not a
// component-owned one.
window.MDE.runCmd = runCmd;
window.MDE.insertLinkIntoEditor = insertLinkIntoEditor;
window.MDE.insertAtCursor = insertBlock;
