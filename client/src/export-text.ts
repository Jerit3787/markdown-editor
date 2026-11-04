// Clean the rendered preview for the text/HTML exports. The preview DOM
// contains app-only controls (the hover "Edit" button on diagram refs) and
// KaTeX renders each formula twice (MathML + visual HTML); both leak into
// a naive innerHTML/innerText export.

export function stripExportUi(root: ParentNode): void {
  root.querySelectorAll(".mermaid-edit-btn").forEach((el) => el.remove());
  // Focus Mode dims non-active blocks on screen; an export is not a
  // reading session, so every paragraph should print at full opacity.
  root.querySelectorAll(".focus-dim").forEach((el) => el.classList.remove("focus-dim"));
}

function replaceMathWithTex(root: ParentNode): void {
  root.querySelectorAll(".katex").forEach((katex) => {
    const tex = katex.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) katex.replaceWith(document.createTextNode(tex));
  });
}

export function previewHtmlForExport(preview: HTMLElement): string {
  const clone = preview.cloneNode(true) as HTMLElement;
  stripExportUi(clone);
  return clone.innerHTML;
}

export function previewTextForExport(preview: HTMLElement): string {
  const clone = preview.cloneNode(true) as HTMLElement;
  stripExportUi(clone);
  // Back-reference arrows are navigation affordances, not document text.
  clone.querySelectorAll("[data-footnote-backref]").forEach((el) => el.remove());
  // Use the TeX source once instead of KaTeX's MathML + HTML duplicate.
  replaceMathWithTex(clone);

  // innerText needs layout; render the clone off-screen at the preview's
  // width, then discard it.
  clone.style.position = "fixed";
  clone.style.left = "-10000px";
  clone.style.top = "0";
  clone.style.width = `${preview.clientWidth || 800}px`;
  clone.style.pointerEvents = "none";
  clone.style.zIndex = "-1";
  document.body.appendChild(clone);
  try {
    const text = typeof clone.innerText === "string" ? clone.innerText : (clone.textContent ?? "");
    return text.replace(/\n{3,}/g, "\n\n").trimEnd();
  } finally {
    clone.remove();
  }
}
