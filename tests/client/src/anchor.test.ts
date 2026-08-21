import { describe, it, expect } from "vitest";
import { relocateAnchor } from "../../../client/src/anchor";

describe("relocateAnchor", () => {
  it("returns the same range when the quote still matches exactly", () => {
    expect(relocateAnchor("hello world", { from: 0, to: 5, quote: "hello" })).toEqual({ from: 0, to: 5 });
  });

  it("relocates to the new position when text shifted", () => {
    expect(relocateAnchor("say hello there", { from: 0, to: 5, quote: "hello" })).toEqual({ from: 4, to: 9 });
  });

  it("returns null when the quote is gone entirely", () => {
    expect(relocateAnchor("nothing matches here", { from: 0, to: 5, quote: "hello" })).toBeNull();
  });

  it("picks the occurrence closest to the stored offset when ambiguous", () => {
    // "hello there, and also hello again" — first "hello" at index 0,
    // second at index 22. A stored from=20 is much closer to the second.
    const content = "hello there, and also hello again";
    expect(relocateAnchor(content, { from: 20, to: 25, quote: "hello" })).toEqual({ from: 22, to: 27 });
  });

  it("returns null for an empty quote", () => {
    expect(relocateAnchor("anything", { from: 0, to: 0, quote: "" })).toBeNull();
  });
});
