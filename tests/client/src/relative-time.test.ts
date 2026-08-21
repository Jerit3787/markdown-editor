import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatRelativeTime } from "../../../client/src/relative-time";

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-08-17T12:00:00Z").getTime();
  const DAY = 86400000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Today' for a timestamp less than a day old", () => {
    expect(formatRelativeTime(NOW - 1000)).toBe("Today");
    expect(formatRelativeTime(NOW)).toBe("Today");
  });

  it("returns 'Yesterday' for a timestamp 1-2 days old", () => {
    expect(formatRelativeTime(NOW - DAY)).toBe("Yesterday");
    expect(formatRelativeTime(NOW - DAY - 1000)).toBe("Yesterday");
  });

  it("returns '{n}d ago' for 2-6 days old", () => {
    expect(formatRelativeTime(NOW - 2 * DAY)).toBe("2d ago");
    expect(formatRelativeTime(NOW - 6 * DAY)).toBe("6d ago");
  });

  it("returns '{n}w ago' for 7-29 days old, rounded down to whole weeks", () => {
    expect(formatRelativeTime(NOW - 7 * DAY)).toBe("1w ago");
    expect(formatRelativeTime(NOW - 13 * DAY)).toBe("1w ago");
    expect(formatRelativeTime(NOW - 14 * DAY)).toBe("2w ago");
    expect(formatRelativeTime(NOW - 29 * DAY)).toBe("4w ago");
  });

  it("returns '{n}mo ago' for 30-364 days old, rounded down to whole months", () => {
    expect(formatRelativeTime(NOW - 30 * DAY)).toBe("1mo ago");
    expect(formatRelativeTime(NOW - 59 * DAY)).toBe("1mo ago");
    expect(formatRelativeTime(NOW - 60 * DAY)).toBe("2mo ago");
    expect(formatRelativeTime(NOW - 364 * DAY)).toBe("12mo ago");
  });

  it("returns a full date with year for 365+ days old", () => {
    const ts = NOW - 365 * DAY;
    expect(formatRelativeTime(ts)).toBe(new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
  });
});
