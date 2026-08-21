import { describe, it, expect } from "vitest";
import { imageKey } from "../../../client/src/image-key";

describe("imageKey", () => {
  it("keeps a simple filename unchanged", () => {
    expect(imageKey("photo.png", {})).toBe("photo.png");
  });

  it("replaces spaces with hyphens instead of stripping them", () => {
    // A space left unescaped in a markdown link destination breaks
    // parsing entirely (see the regression this guards against) —
    // it must never survive into the generated key.
    expect(imageKey("my photo.png", {})).toBe("my-photo.png");
  });

  it("preserves periods in the base name", () => {
    // Regression: macOS screenshot filenames like this one used to have
    // their internal periods stripped, producing a key that still
    // collided with nothing in `images` but no longer matched what a
    // human would recognize — periods are valid in a link destination
    // and were never the actual problem (spaces were).
    expect(imageKey("Screenshot 2026-08-13 at 5.22.26 PM.png", {})).toBe("Screenshot-2026-08-13-at-5.22.26-PM.png");
  });

  it("strips characters unsafe in a markdown link destination", () => {
    expect(imageKey("photo (final)!.png", {})).toBe("photo-final.png");
  });

  it("suffixes with -2 on a collision", () => {
    expect(imageKey("photo.png", { "photo.png": "data:..." })).toBe("photo-2.png");
  });

  it("keeps incrementing past an already-taken suffix", () => {
    expect(imageKey("photo.png", { "photo.png": "data:...", "photo-2.png": "data:..." })).toBe("photo-3.png");
  });

  it("falls back to a default extension when the filename has none", () => {
    expect(imageKey("photo", {})).toBe("photo.png");
  });

  it("falls back to a default base name for an empty filename", () => {
    expect(imageKey("", {})).toBe("image.png");
  });
});
