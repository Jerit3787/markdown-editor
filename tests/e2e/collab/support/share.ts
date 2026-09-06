import type { Page } from "@playwright/test";

type ShareState = {
  activeDoc: { id: string; [k: string]: unknown } | undefined;
  ws: { id: string; shared?: boolean; remoteId?: string; [k: string]: unknown } | undefined;
};

// Reads the workspace/doc state used to build a `/w/<remoteId>/<docId>/edit`
// join URL — but only once the share flow has FULLY landed client-side.
//
// The Share modal fires `PUT /api/workspace/:id/access`; `waitForResponse`
// on that PUT resolves as soon as the HTTP response arrives, but the
// client's own `.then()` handler that writes `shared: true` + `remoteId`
// into `mde:workspaces` and calls `persistWorkspaces()` runs a microtask
// later. Reading `localStorage` synchronously right after the PUT therefore
// races that write and intermittently sees `shared: undefined` / no
// `remoteId` — the root of several flaky collab specs. This polls until the
// persisted state is actually consistent before returning it.
export async function readSharedState(page: Page, docId?: string): Promise<ShareState> {
  await page.waitForFunction(
    (wantDocId) => {
      const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
      const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
      const activeId = wantDocId ?? localStorage.getItem("mde:active");
      const doc = docs.find((d: { id: string }) => d.id === activeId);
      const ws = wss.find((w: { id: string }) => w.id === doc?.workspaceId);
      return !!(doc && ws && ws.shared && ws.remoteId);
    },
    docId ?? null,
    { timeout: 15000 },
  );

  return page.evaluate((wantDocId) => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = wantDocId ?? localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws } as ShareState;
  }, docId ?? null);
}
