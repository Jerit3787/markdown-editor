import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import Settings from "../../../../client/src/components/Settings.svelte";
import { driveConnected, driveConfigured } from "../../../../client/src/stores/driveSync";

beforeEach(() => {
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  driveConnected.set(false);
  driveConfigured.set(true);
  // Settings opens on a #settingsBtn click.
  document.body.querySelector("#settingsBtn")?.remove();
  const btn = document.createElement("button");
  btn.id = "settingsBtn";
  document.body.appendChild(btn);
});

async function openSettings() {
  const screen = await render(Settings);
  (document.getElementById("settingsBtn") as HTMLButtonElement).click();
  return screen;
}

function driveRow(container: Element): Element | undefined {
  return Array.from(container.querySelectorAll(".setting-row")).find((r) => r.querySelector(".setting-title")?.textContent?.trim() === "Google Drive");
}

test("drive: shows a Google Drive Connect button, switching to Disconnect once connected", async () => {
  const screen = await openSettings();
  await expect.poll(() => driveRow(screen.container)?.querySelector("button")?.textContent?.trim()).toBe("Connect");
  driveConnected.set(true);
  await expect.poll(() => driveRow(screen.container)?.querySelector("button")?.textContent?.trim()).toBe("Disconnect");
});

test("drive: the whole Google Drive row is hidden when the feature is unconfigured", async () => {
  driveConfigured.set(false);
  const screen = await openSettings();
  await expect.poll(() => screen.container.textContent).not.toContain("Google Drive");
});
