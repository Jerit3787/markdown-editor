import { describe, it, expect } from "vitest";
import { PDF_EXPORT_STYLE_TEXT } from "../../../client/src/pdf-export-style";

describe("PDF export clone styles", () => {
  it("wraps long code lines instead of clipping them at the page edge", () => {
    expect(PDF_EXPORT_STYLE_TEXT).toContain("white-space: pre-wrap !important");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("overflow: visible !important");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("overflow-wrap: anywhere");
  });

  it("keeps wide tables inside the page and blocks from splitting across pages", () => {
    expect(PDF_EXPORT_STYLE_TEXT).toContain("table-layout: fixed");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("break-inside: avoid");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("page-break-inside: avoid");
  });

  it("scopes every rule to the exported wrapper so the live preview is unchanged", () => {
    const selectors = PDF_EXPORT_STYLE_TEXT.split("}")
      .map((rule) => rule.split("{")[0]?.trim() ?? "")
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toContain(".pdf-export-wrapper");
  });
});
