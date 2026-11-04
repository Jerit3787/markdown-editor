import { describe, it, expect } from "vitest";
import { PDF_EXPORT_STYLE_TEXT } from "../../../client/src/pdf-export-style";

describe("PDF export clone styles", () => {
  it("forces readable light colors even when the app is in dark mode", () => {
    expect(PDF_EXPORT_STYLE_TEXT).toContain("--text: #1f2328");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("--bg: #ffffff");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("background: var(--bg)");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("color: var(--text)");
  });

  it("wraps long code lines instead of clipping them at the page edge", () => {
    expect(PDF_EXPORT_STYLE_TEXT).toContain("white-space: pre-wrap !important");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("overflow: visible !important");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("overflow-wrap: anywhere");
  });

  it("keeps inline code on one line so its background cannot stretch across a page break", () => {
    expect(PDF_EXPORT_STYLE_TEXT).toContain("code:not(pre code)");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("white-space: nowrap");
  });

  it("lays standalone images out as blocks but leaves inline images inline", () => {
    expect(PDF_EXPORT_STYLE_TEXT).toContain("img:only-child");
    expect(PDF_EXPORT_STYLE_TEXT).toContain("display: block");
    const avoidRule = PDF_EXPORT_STYLE_TEXT.split("}").find((rule) => rule.includes("break-inside"));
    expect(avoidRule).toBeTruthy();
    expect(avoidRule).not.toContain("#preview img");
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
