// PDF-specific clone styles. The live preview scrolls long code lines and
// wide tables; html2canvas renders those scrollable boxes at their clipped
// width, so text disappeared at the page edge. Scoping the rules to the
// exported wrapper keeps the on-screen preview unchanged.

export const PDF_EXPORT_STYLE_TEXT = `
  .pdf-export-wrapper {
    /* Force the light palette even when the app is in dark mode;
       html2canvas draws onto a white page. */
    --bg: #ffffff;
    --bg-alt: #f6f7f9;
    --border: #e2e5e9;
    --text: #1f2328;
    --text-dim: #6b7280;
    --accent: #2563eb;
    --accent-dim: #eaf0fe;
    --danger: #dc2626;
    --shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  .pdf-export-wrapper #preview { overflow: visible !important; }
  .pdf-export-wrapper #preview pre {
    white-space: pre-wrap !important;
    overflow: visible !important;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .pdf-export-wrapper #preview pre code { white-space: inherit !important; }
  .pdf-export-wrapper #preview code:not(pre code) { white-space: nowrap; }
  .pdf-export-wrapper #preview table { table-layout: fixed; width: 100% !important; }
  .pdf-export-wrapper #preview th,
  .pdf-export-wrapper #preview td { overflow-wrap: anywhere; word-break: break-word; }
  .pdf-export-wrapper #preview img { max-width: 100% !important; height: auto !important; }
  .pdf-export-wrapper #preview p > img:only-child { display: block; margin: 16px auto; }
  .pdf-export-wrapper #preview p:has(> img:only-child),
  .pdf-export-wrapper #preview figure { break-inside: avoid; page-break-inside: avoid; }
  .pdf-export-wrapper #preview pre,
  .pdf-export-wrapper #preview table,
  .pdf-export-wrapper #preview blockquote,
  .pdf-export-wrapper #preview pre.mermaid { break-inside: avoid; page-break-inside: avoid; }
`;
