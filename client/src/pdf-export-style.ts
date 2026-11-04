// PDF-specific clone styles. The live preview scrolls long code lines and
// wide tables; html2canvas renders those scrollable boxes at their clipped
// width, so text disappeared at the page edge. Scoping the rules to the
// exported wrapper keeps the on-screen preview unchanged.

export const PDF_EXPORT_STYLE_TEXT = `
  .pdf-export-wrapper #preview { overflow: visible !important; }
  .pdf-export-wrapper #preview pre {
    white-space: pre-wrap !important;
    overflow: visible !important;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .pdf-export-wrapper #preview pre code { white-space: inherit !important; }
  .pdf-export-wrapper #preview table { table-layout: fixed; width: 100% !important; }
  .pdf-export-wrapper #preview th,
  .pdf-export-wrapper #preview td { overflow-wrap: anywhere; word-break: break-word; }
  .pdf-export-wrapper #preview img { max-width: 100% !important; height: auto !important; }
  .pdf-export-wrapper #preview pre,
  .pdf-export-wrapper #preview table,
  .pdf-export-wrapper #preview blockquote,
  .pdf-export-wrapper #preview img,
  .pdf-export-wrapper #preview pre.mermaid { break-inside: avoid; page-break-inside: avoid; }
`;
