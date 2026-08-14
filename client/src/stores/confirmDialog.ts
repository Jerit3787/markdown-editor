import { writable } from "svelte/store";

interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
}

export const confirmRequest = writable<ConfirmRequest | null>(null);

// Awaitable from plain (non-Svelte) code exactly like window.confirm()
// was — the only thing that changes at each call site is adding
// `await` and making the enclosing function async.
export function confirmAction(message: string, confirmLabel = "Delete", danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    confirmRequest.set({ message, confirmLabel, danger, resolve });
  });
}
