import { writable } from "svelte/store";

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
}

export const confirmRequest = writable<ConfirmRequest | null>(null);

export function confirmAction(title: string, message: string, confirmLabel = "Delete", danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    confirmRequest.set({ title, message, confirmLabel, danger, resolve });
  });
}
