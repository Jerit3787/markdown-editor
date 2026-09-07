// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyFocusDim } from "../../../client/src/preview-focus-dim";

function blocks(lines: (number | null)[]): HTMLElement[] {
  return lines.map((ln) => {
    const el = document.createElement("div");
    if (ln !== null) el.setAttribute("data-line", String(ln));
    return el;
  });
}

describe("applyFocusDim", () => {
  it("dims every block outside the active paragraph (1-based range → 0-based data-line)", () => {
    // blocks at source lines 0, 2, 4 (heading, para one, para two)
    const els = blocks([0, 2, 4]);
    applyFocusDim(els, { from: 3, to: 3 }); // "para one" starts at line 3 (1-based) == data-line 2
    expect(els.map((e) => e.classList.contains("focus-dim"))).toEqual([true, false, true]);
  });

  it("keeps a multi-line active paragraph's block undimmed", () => {
    const els = blocks([0, 2, 6]); // block 2 spans lines 2..5 (0-based) => 3..6 (1-based)
    applyFocusDim(els, { from: 4, to: 5 });
    expect(els.map((e) => e.classList.contains("focus-dim"))).toEqual([true, false, true]);
  });

  it("clears all dimming when the active range is null", () => {
    const els = blocks([0, 2, 4]);
    els.forEach((e) => e.classList.add("focus-dim"));
    applyFocusDim(els, null);
    expect(els.some((e) => e.classList.contains("focus-dim"))).toBe(false);
  });

  it("never dims an untagged block", () => {
    const els = blocks([0, null, 4]);
    applyFocusDim(els, { from: 5, to: 5 }); // active is the last block
    expect(els[1].classList.contains("focus-dim")).toBe(false);
    expect(els[0].classList.contains("focus-dim")).toBe(true);
    expect(els[2].classList.contains("focus-dim")).toBe(false);
  });

  it("re-clears a block that was dimmed on a previous call", () => {
    const els = blocks([0, 2, 4]);
    applyFocusDim(els, { from: 1, to: 1 }); // block 0 active
    expect(els.map((e) => e.classList.contains("focus-dim"))).toEqual([false, true, true]);
    applyFocusDim(els, { from: 5, to: 5 }); // block 2 active now
    expect(els.map((e) => e.classList.contains("focus-dim"))).toEqual([true, true, false]);
  });
});
