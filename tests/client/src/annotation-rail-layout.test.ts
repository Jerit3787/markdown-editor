import { describe, it, expect } from "vitest";
import { layoutCards, type CardAnchor } from "../../../client/src/annotation-rail-layout";

const vp = { height: 500 };

describe("layoutCards", () => {
  it("returns nothing for no anchors", () => {
    expect(layoutCards([], vp, 8)).toEqual([]);
  });

  it("places a single visible card at its anchor (never above 0)", () => {
    expect(layoutCards([{ id: "a", anchorY: 120, height: 60 }], vp, 8)).toEqual([{ id: "a", top: 120, clamped: null }]);
    expect(layoutCards([{ id: "a", anchorY: -30, height: 60 }], vp, 8)).toEqual([{ id: "a", top: 0, clamped: null }]);
  });

  it("pushes a colliding lower card below the previous card + gap", () => {
    const anchors: CardAnchor[] = [
      { id: "a", anchorY: 100, height: 60 },
      { id: "b", anchorY: 110, height: 60 },
    ];
    const out = layoutCards(anchors, vp, 8);
    expect(out.find((p) => p.id === "a")!.top).toBe(100);
    expect(out.find((p) => p.id === "b")!.top).toBe(168); // 100 + 60 + 8
  });

  it("keeps document order regardless of input order", () => {
    const out = layoutCards(
      [
        { id: "b", anchorY: 300, height: 40 },
        { id: "a", anchorY: 100, height: 40 },
      ],
      vp,
      8,
    );
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("clamps a null 'above' anchor to the top and a null 'below' anchor to the bottom", () => {
    const out = layoutCards(
      [
        { id: "up", anchorY: null, direction: "above", height: 50 },
        { id: "down", anchorY: null, direction: "below", height: 50 },
      ],
      vp,
      8,
    );
    expect(out.find((p) => p.id === "up")).toEqual({ id: "up", top: 0, clamped: "top" });
    expect(out.find((p) => p.id === "down")).toEqual({ id: "down", top: 450, clamped: "bottom" });
  });

  it("keeps a clustered over-full stack non-overlapping and at/below anchors (overflow allowed)", () => {
    const anchors: CardAnchor[] = [
      { id: "a", anchorY: 200, height: 200 },
      { id: "b", anchorY: 260, height: 200 },
      { id: "c", anchorY: 320, height: 200 },
    ];
    const out = layoutCards(anchors, vp, 0);
    const byId = Object.fromEntries(out.map((p) => [p.id, p.top]));
    expect(byId.a).toBe(200); // at its anchor
    expect(byId.b).toBeGreaterThanOrEqual(byId.a + 200); // no overlap
    expect(byId.c).toBeGreaterThanOrEqual(byId.b + 200);
    expect(byId.a).toBeLessThanOrEqual(200); // never above its anchor
  });
});
