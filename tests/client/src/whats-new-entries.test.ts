import { describe, it, expect } from "vitest";
import { WHATS_NEW_ENTRIES } from "../../../client/src/whats-new-entries";
import type { WhatsNewCategory } from "../../../client/src/whats-new-entries";

const KNOWN_CATEGORIES: WhatsNewCategory[] = ["Editing & Formatting", "Collaboration", "Version History", "GitHub Integration", "Organization & Navigation"];

describe("WHATS_NEW_ENTRIES categories", () => {
  it("every entry has a category from the known set", () => {
    for (const entry of WHATS_NEW_ENTRIES) {
      expect(KNOWN_CATEGORIES).toContain(entry.category);
    }
  });
});
