// Presentational state for ShareChoiceModal.svelte — a three-way variant
// of stores/confirmDialog.ts's confirmRequest/confirmAction pattern.
// Cancel + one action isn't enough here: sharing a document that has
// siblings needs a real choice between "just this document" and "the
// whole workspace", not a single yes/no.
import { writable } from "svelte/store";

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
    shareChoiceRequest.set({ docName, workspaceName, docCount, resolve });
  });
}
