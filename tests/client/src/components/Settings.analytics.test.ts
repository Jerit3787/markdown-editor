import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

vi.mock("../../../../client/src/analytics", () => ({
  analyticsAvailable: true,
  initAnalytics: vi.fn(),
  track: vi.fn(),
  setSignedIn: vi.fn(),
}));

import Settings from "../../../../client/src/components/Settings.svelte";
import { settingsModalOpen } from "../../../../client/src/stores/settingsModal";
import { analyticsConsent } from "../../../../client/src/stores/analyticsConsent";

beforeEach(() => {
  settingsModalOpen.set(true);
  analyticsConsent.set("unset");
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  localStorage.clear();
});

test("shows an Analytics On/Off control reflecting consent, and toggling it sets consent", async () => {
  const screen = await render(Settings);
  await expect.element(screen.getByText("Analytics")).toBeVisible();
  await screen.getByRole("tab", { name: /^on$/i }).click();
  expect(get(analyticsConsent)).toBe("granted");
  await screen.getByRole("tab", { name: /^off$/i }).click();
  expect(get(analyticsConsent)).toBe("denied");
});
