// Toasts for actions that were previously silent (or only visible as a
// transient inline label swap) — doc duplicate/delete, share/access
// changes, publish/export, and surfacing failures that used to fail
// quietly. Any file can call showToast(); Toast.svelte (mounted once at
// app root) is the only thing that reads the store.
import { writable } from "svelte/store";

export type ToastType = "success" | "error" | "info";

export interface ToastMsg {
  id: number;
  message: string;
  type: ToastType;
}

export const toasts = writable<ToastMsg[]>([]);

let nextId = 1;

export function showToast(message: string, type: ToastType = "info", duration = 3200) {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, type }]);
  setTimeout(() => dismissToast(id), duration);
}

export function dismissToast(id: number) {
  toasts.update((list) => list.filter((t) => t.id !== id));
}
