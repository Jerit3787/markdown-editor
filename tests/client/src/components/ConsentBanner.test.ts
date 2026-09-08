import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

vi.mock("../../../../client/src/analytics", () => ({
  analyticsAvailable: true,
  initAnalytics: vi.fn(),
}));

import ConsentBanner from "../../../../client/src/components/ConsentBanner.svelte";
import { analyticsConsent } from "../../../../client/src/stores/analyticsConsent";

beforeEach(() => {
  analyticsConsent.set("unset");
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

test("renders when consent is unset, with Accept / Decline and a privacy link", async () => {
  const screen = await render(ConsentBanner);
  await expect.element(screen.getByRole("button", { name: /accept/i })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /decline/i })).toBeVisible();
  expect(screen.container.querySelector('a[href="/privacy"]')).not.toBeNull();
});

test("Accept sets consent granted and hides the banner", async () => {
  const screen = await render(ConsentBanner);
  await screen.getByRole("button", { name: /accept/i }).click();
  expect(get(analyticsConsent)).toBe("granted");
  await expect.poll(() => screen.container.querySelector(".consent-banner")).toBeNull();
});

test("Decline sets consent denied and hides the banner", async () => {
  const screen = await render(ConsentBanner);
  await screen.getByRole("button", { name: /decline/i }).click();
  expect(get(analyticsConsent)).toBe("denied");
  await expect.poll(() => screen.container.querySelector(".consent-banner")).toBeNull();
});

test("never renders once a choice is already made", async () => {
  analyticsConsent.set("granted");
  const screen = await render(ConsentBanner);
  expect(screen.container.querySelector(".consent-banner")).toBeNull();
});
