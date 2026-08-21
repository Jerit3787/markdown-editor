// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { svgOuterHtmlForExport } from "../../../client/src/diagram-export";

describe("svgOuterHtmlForExport", () => {
  it("adds an xmlns attribute when missing, so the exported file is a valid standalone SVG", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = "<rect width='10' height='10' />";
    const result = svgOuterHtmlForExport(svg);
    expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("keeps an existing xmlns attribute as the only one", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("data-test", "1");
    const result = svgOuterHtmlForExport(svg);
    expect(result).toContain('data-test="1"');
    expect((result.match(/xmlns=/g) || []).length).toBe(1);
  });

  it("does not mutate the original element", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgOuterHtmlForExport(svg);
    expect(svg.getAttribute("xmlns")).toBeNull();
  });
});
