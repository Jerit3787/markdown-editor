// Presentational state for ShareChoiceModal.svelte — a three-way variant
// of stores/confirmDialog.ts's confirmRequest/confirmAction pattern.
// Cancel + one action isn't enough here: sharing a document that has
// siblings needs a real choice between "just this document" and "the
// whole workspace", not a single yes/no.
import { get, writable } from "svelte/store";

export type ShareChoiceResult = "cancel" | "document" | "workspace";

export interface ShareChoiceRequestState {
  docName: string;
  workspaceName: string;
  docCount: number;
  resolve: (choice: ShareChoiceResult) => void;
}

export const shareChoiceRequest = writable<ShareChoiceRequestState | null>(null);

export function shareChoice(docName: string, workspaceName: string, docCount: number): Promise<ShareChoiceResult> {
  return new Promise((resolve) => {
    // A second request replaces the store value; without this the first
    // caller's promise would never settle (the modal now resolves the
    // second). Cancel the superseded flow explicitly.
    get(shareChoiceRequest)?.resolve("cancel");
    shareChoiceRequest.set({ docName, workspaceName, docCount, resolve });
  });
}
