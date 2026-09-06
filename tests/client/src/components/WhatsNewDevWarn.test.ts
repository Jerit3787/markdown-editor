import { test, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";

// SHELL-11 — WhatsNew.svelte's dev guard (instance-script top level, so it
// runs on mount): when the newest WHATS_NEW_ENTRIES version doesn't match
// __APP_VERSION__ it console.warns, so a forgotten announcement entry
// doesn't ship silently. __APP_VERSION__ here is the real package.json
// version (vitest.config.ts define), so this mocks the entries module to a
// deliberately-stale last version.

vi.mock("../../../../client/src/whats-new-entries", () => ({
  WHATS_NEW_ENTRIES: [{ version: "0.0.1-stale", title: "Stale", description: "d", screenshot: "/whats-new/x.png", category: "Editing & Formatting" }],
}));

test("SHELL-11: warns on mount when the newest entry's version != __APP_VERSION__", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const WhatsNew = (await import("../../../../client/src/components/WhatsNew.svelte")).default;
  await render(WhatsNew);
  expect(warn.mock.calls.map((c) => String(c[0])).some((m) => /no announcement entry for the current version/.test(m))).toBe(true);
  warn.mockRestore();
});
