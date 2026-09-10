import { describe, it, expect } from "vitest";
import { randomAnonId, randomGuestName, GUEST_ADJECTIVES, GUEST_ANIMALS } from "../../src/guest-names";

describe("guest-names", () => {
  it("mints an anon id with the anon: prefix and 16 base62 chars", () => {
    expect(randomAnonId()).toMatch(/^anon:[0-9A-Za-z]{16}$/);
  });

  it("mints distinct ids", () => {
    expect(randomAnonId()).not.toBe(randomAnonId());
  });

  it("makes a two-word guest name from the lists", () => {
    const [adj, animal] = randomGuestName().split(" ");
    expect(GUEST_ADJECTIVES).toContain(adj);
    expect(GUEST_ANIMALS).toContain(animal);
  });
});
