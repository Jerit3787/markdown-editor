import { describe, it, expect } from "vitest";
import { nextAnnouncement, MODE_ANNOUNCE_COPY, type ModeState } from "../../../client/src/mode-announce";

const S = (remoteId: string | null, mode: ModeState["mode"]): ModeState => ({ remoteId, mode });

describe("nextAnnouncement", () => {
  it("says nothing for a plain local document (no mode, no workspace)", () => {
    expect(nextAnnouncement(S(null, null), S(null, null), new Set())).toBeNull();
  });

  it("announces the mode on first entry to a workspace and marks it seen", () => {
    const seen = new Set<string>();
    expect(nextAnnouncement(S(null, null), S("w1", "viewing"), seen)).toBe("viewing");
    expect(seen.has("w1")).toBe(true);
  });

  it("announces a real mode change within the same workspace", () => {
    expect(nextAnnouncement(S("w1", "viewing"), S("w1", "suggesting"), new Set(["w1"]))).toBe("suggesting");
  });

  it("says nothing when the mode is unchanged in a workspace already seen", () => {
    expect(nextAnnouncement(S("w1", "viewing"), S("w1", "viewing"), new Set(["w1"]))).toBeNull();
  });

  it("says nothing when re-entering a workspace already announced this session", () => {
    expect(nextAnnouncement(S(null, null), S("w1", "viewing"), new Set(["w1"]))).toBeNull();
  });

  it("says nothing when leaving a workspace", () => {
    expect(nextAnnouncement(S("w1", "viewing"), S(null, null), new Set(["w1"]))).toBeNull();
  });

  it("announces on switching to a different, unseen workspace and marks it seen", () => {
    const seen = new Set<string>(["w1"]);
    expect(nextAnnouncement(S("w1", "editing"), S("w2", "viewing"), seen)).toBe("viewing");
    expect(seen.has("w2")).toBe(true);
  });
});

describe("MODE_ANNOUNCE_COPY", () => {
  it("has the exact agreed string for each mode", () => {
    expect(MODE_ANNOUNCE_COPY).toEqual({
      editing: "You're now editing",
      suggesting: "You're now suggesting",
      viewing: "You're now viewing",
    });
  });
});
