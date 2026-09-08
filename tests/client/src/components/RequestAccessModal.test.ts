import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import RequestAccessModal from "../../../../client/src/components/RequestAccessModal.svelte";
import { requestAccessModalOpen, myAccessRequestPending } from "../../../../client/src/stores/share";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";

beforeEach(() => {
  requestAccessModalOpen.set(false);
  myAccessRequestPending.set(false);
  window.MDE = { githubUsername: "bob" } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0, shared: true, remoteId: "remote-1" }]);
  activeWorkspaceIdStore.set("w1");
});

test("CV2-5: renders the note field + buttons when open, POSTs the message on submit", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  vi.stubGlobal("fetch", fetchMock);
  requestAccessModalOpen.set(true);
  const screen = await render(RequestAccessModal);

  await screen.getByRole("textbox").fill("need to fix a typo");
  await screen.getByRole("button", { name: /send request/i }).click();

  await expect.poll(() => fetchMock.mock.calls.length).toBeGreaterThan(0);
  const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
  expect(url).toContain("/api/workspace/remote-1/access-request");
  expect(JSON.parse(opts.body).message).toBe("need to fix a typo");
  await expect.poll(() => screen.container.textContent?.includes("Request edit access")).toBe(false); // closed
  vi.unstubAllGlobals();
});
