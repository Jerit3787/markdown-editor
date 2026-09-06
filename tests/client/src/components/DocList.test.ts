import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import DocList from "../../../../client/src/components/DocList.svelte";
import { docsStore, activeIdStore, activeDocContent } from "../../../../client/src/stores/docs";
import { activeWorkspaceIdStore, workspacesStore } from "../../../../client/src/stores/workspaces";
import { docListActiveTab } from "../../../../client/src/stores/docList";

beforeEach(() => {
  window.MDE = { switchDoc: vi.fn(), jumpToLine: vi.fn(), updatePreview: vi.fn() } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docListActiveTab.set("documents");
});

test("DOC-21: renders documents sorted alphabetically (locale-aware, case-insensitive)", async () => {
  docsStore.set([
    { id: "z", name: "Zebra", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
    { id: "a", name: "apple", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
    { id: "m", name: "Mango", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
  ]);
  activeIdStore.set("a");
  const screen = await render(DocList);

  const names = (await screen.container.querySelectorAll(".doc-name")).length
    ? Array.from(screen.container.querySelectorAll(".doc-name")).map((el) => el.textContent?.trim())
    : [];
  expect(names).toEqual(["apple", "Mango", "Zebra"]);
});

test("DOC-21: the Headings tab shows the active document's live heading outline", async () => {
  docsStore.set([{ id: "a", name: "Doc A", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set("a");
  activeDocContent.set("# One\n\ntext\n\n## Two\n\n### Three");
  const screen = await render(DocList);

  await screen.getByRole("button", { name: "Headings" }).click();
  const outline = Array.from(screen.container.querySelectorAll(".doclist-headings-tab .outline-item")).map((el) => el.textContent?.trim());
  expect(outline).toEqual(["One", "Two", "Three"]);
  // Nesting is conveyed by data-level.
  const levels = Array.from(screen.container.querySelectorAll(".doclist-headings-tab .outline-item")).map((el) => el.getAttribute("data-level"));
  expect(levels).toEqual(["1", "2", "3"]);
});

test("DOC-21: only documents in the active workspace are listed", async () => {
  workspacesStore.set([
    { id: "w1", name: "WS1", createdAt: 0, updatedAt: 0 },
    { id: "w2", name: "WS2", createdAt: 0, updatedAt: 0 },
  ]);
  docsStore.set([
    { id: "a", name: "In W1", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
    { id: "b", name: "In W2", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w2" },
  ]);
  activeIdStore.set("a");
  const screen = await render(DocList);
  const names = Array.from(screen.container.querySelectorAll(".doc-name")).map((el) => el.textContent?.trim());
  expect(names).toEqual(["In W1"]);
});

test("COLLAB-42: a document row shows a presence avatar per collaborator viewing it, capped at 3", async () => {
  const { workspacePresence } = await import("../../../../client/src/stores/workspacePresence");
  docsStore.set([
    { id: "a", name: "Doc A", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
    { id: "b", name: "Doc B", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1" },
  ]);
  activeIdStore.set("a");
  workspacePresence.set(
    new Map([
      [
        "a",
        [
          { username: "alice", color: "#f00" },
          { username: "bob", color: "#0f0" },
          { username: "carol", color: "#00f" },
          { username: "dave", color: "#ff0" },
        ],
      ],
    ]),
  );

  const screen = await render(DocList);

  const rowA = screen.container.querySelectorAll("#docList li")[0]!;
  const rowB = screen.container.querySelectorAll("#docList li")[1]!;
  expect(rowA.querySelectorAll(".presence-avatar").length).toBe(3); // 4 viewers, capped at 3
  expect(rowA.querySelector(".presence-avatar")?.textContent).toBe("A"); // first initial, uppercased
  expect(rowB.querySelectorAll(".presence-avatar").length).toBe(0); // nobody on Doc B

  workspacePresence.set(new Map());
});
