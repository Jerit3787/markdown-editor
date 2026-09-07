import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import WorkspaceSwitcher from "../../../../client/src/components/WorkspaceSwitcher.svelte";
import { workspacesStore, activeWorkspaceIdStore } from "../../../../client/src/stores/workspaces";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { confirmRequest } from "../../../../client/src/stores/confirmDialog";

function stubMDE(extra: Record<string, unknown> = {}) {
  window.MDE = {
    updatePreview: vi.fn(),
    setReadOnly: vi.fn(),
    exitCollabMode: vi.fn(),
    enterCollabMode: vi.fn(),
    getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
    ...extra,
  } as unknown as typeof window.MDE;
}

beforeEach(() => {
  stubMDE();
  workspacesStore.set([
    { id: "wa", name: "Alpha", createdAt: 1, updatedAt: 1 },
    { id: "wb", name: "Bravo", createdAt: 2, updatedAt: 2 },
  ]);
  activeWorkspaceIdStore.set("wa");
  docsStore.set([
    { id: "da", name: "Doc A", content: "", updatedAt: 0, createdAt: 0, workspaceId: "wa" },
    { id: "db", name: "Doc B", content: "", updatedAt: 0, createdAt: 0, workspaceId: "wb" },
  ]);
  activeIdStore.set("da");
});

// One-shot: auto-answer the next confirmAction() and capture what it asked.
function autoConfirm(answer: boolean): { seen: { title: string; message: string } | null } {
  const box: { seen: { title: string; message: string } | null } = { seen: null };
  const unsub = confirmRequest.subscribe((req) => {
    if (!req) return;
    box.seen = { title: req.title, message: req.message };
    unsub();
    req.resolve(answer);
    confirmRequest.set(null);
  });
  return box;
}

afterEach(() => confirmRequest.set(null));

test("DOC-09: shows the active workspace name and switches to another on click", async () => {
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Alpha").click(); // open the popover (trigger shows the active name)
  await screen.getByText("Bravo").click();
  expect(get(activeWorkspaceIdStore)).toBe("wb");
});

test("DOC-09: 'New workspace' creates one, activates it, and drops into rename mode", async () => {
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Alpha").click();
  const before = get(workspacesStore).length;
  await screen.getByRole("button", { name: "New workspace" }).click();

  const wss = get(workspacesStore);
  expect(wss.length).toBe(before + 1);
  const created = wss.find((w) => w.id !== "wa" && w.id !== "wb")!;
  expect(created).toBeDefined();
  expect(get(activeWorkspaceIdStore)).toBe(created.id);
  // startCreate opens the inline rename input on the new row.
  await expect.element(screen.getByRole("textbox")).toBeVisible();
});

test("DOC-09: renaming a workspace inline updates its name", async () => {
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Alpha").click();
  await screen.getByRole("button", { name: "Rename workspace" }).first().click();
  const input = screen.getByRole("textbox");
  await input.fill("Alpha Renamed");
  await input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  expect(get(workspacesStore).find((w) => w.id === "wa")?.name).toBe("Alpha Renamed");
});

test("delete: a private workspace uses the plain confirm copy and makes no network call", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const box = autoConfirm(true);
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Alpha").click();
  await screen.getByRole("button", { name: "Delete workspace" }).first().click();
  await vi.waitFor(() => expect(get(workspacesStore).find((w) => w.id === "wa")).toBeUndefined());

  expect(box.seen?.title).toBe('Delete "Alpha"?');
  expect(box.seen?.message).toContain("1 document");
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test("delete: a mirrored workspace says 'removes your local copy' and makes no network call", async () => {
  workspacesStore.set([{ id: "wm", name: "Mirror", createdAt: 1, updatedAt: 1, shared: true, remoteId: "r-m", mirrored: true }]);
  activeWorkspaceIdStore.set("wm");
  docsStore.set([{ id: "dm", name: "D", content: "", updatedAt: 0, createdAt: 0, workspaceId: "wm" }]);
  activeIdStore.set("dm");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const box = autoConfirm(true);
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Mirror").click();
  await screen.getByRole("button", { name: "Delete workspace" }).first().click();
  await vi.waitFor(() => expect(get(workspacesStore).find((w) => w.id === "wm")).toBeUndefined());

  expect(box.seen?.message).toContain("removes your local copy");
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test("delete: owner of a shared workspace warns about collaborators and DELETEs the room", async () => {
  stubMDE({ githubUsername: "alice" });
  workspacesStore.set([{ id: "wo", name: "Owned", createdAt: 1, updatedAt: 1, shared: true, remoteId: "r-o" }]);
  activeWorkspaceIdStore.set("wo");
  docsStore.set([{ id: "do1", name: "D", content: "", updatedAt: 0, createdAt: 0, workspaceId: "wo" }]);
  activeIdStore.set("do1");
  const fetchSpy = vi.fn(async (url: string, init?: { method?: string }) => {
    if (url.includes("/access")) return { ok: true, json: async () => ({ owner: "alice" }) };
    return { ok: true, status: 204 };
  });
  vi.stubGlobal("fetch", fetchSpy);
  const box = autoConfirm(true);
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Owned").click();
  await screen.getByRole("button", { name: "Delete workspace" }).first().click();
  await vi.waitFor(() => expect(get(workspacesStore).find((w) => w.id === "wo")).toBeUndefined());

  expect(box.seen?.message).toContain("everyone you've shared it with");
  expect(fetchSpy.mock.calls.some(([u, i]) => u === "/api/workspace/r-o" && i?.method === "DELETE")).toBe(true);
  vi.unstubAllGlobals();
});

test("delete: a merged shared workspace (not owner) removes locally without promising a revoke", async () => {
  stubMDE({ githubUsername: "bob" });
  workspacesStore.set([{ id: "wg", name: "Merged", createdAt: 1, updatedAt: 1, shared: true, remoteId: "r-g" }]);
  activeWorkspaceIdStore.set("wg");
  docsStore.set([{ id: "dg", name: "D", content: "", updatedAt: 0, createdAt: 0, workspaceId: "wg" }]);
  activeIdStore.set("dg");
  const fetchSpy = vi.fn(async (url: string) => {
    if (url.includes("/access")) return { ok: true, json: async () => ({ owner: "alice" }) };
    return { ok: false, status: 403 };
  });
  vi.stubGlobal("fetch", fetchSpy);
  const box = autoConfirm(true);
  const screen = await render(WorkspaceSwitcher);
  await screen.getByText("Merged").click();
  await screen.getByRole("button", { name: "Delete workspace" }).first().click();
  await vi.waitFor(() => expect(get(workspacesStore).find((w) => w.id === "wg")).toBeUndefined());

  expect(box.seen?.title).toBe('Remove "Merged"?');
  expect(box.seen?.message).toContain("stays available to its owner");
  vi.unstubAllGlobals();
});
