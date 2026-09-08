import { test, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";

vi.mock("../../../../client/src/analytics", () => ({ analyticsAvailable: false, initAnalytics: vi.fn() }));

import ConsentBanner from "../../../../client/src/components/ConsentBanner.svelte";
import { analyticsConsent } from "../../../../client/src/stores/analyticsConsent";

test("never renders when analytics is unavailable, even if consent is unset", async () => {
  analyticsConsent.set("unset");
  const screen = await render(ConsentBanner);
  expect(screen.container.querySelector(".consent-banner")).toBeNull();
});
