import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const about = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../client/src/components/AboutModal.svelte"), "utf8");

describe("About modal legal links", () => {
  it("links out to /terms and /privacy in a new tab", () => {
    expect(about).toMatch(/href="\/terms"[^>]*target="_blank"/);
    expect(about).toMatch(/href="\/privacy"[^>]*target="_blank"/);
  });
  it("no longer references the deleted modal stores", () => {
    expect(about).not.toContain("termsModalOpen");
    expect(about).not.toContain("privacyModalOpen");
  });
});
