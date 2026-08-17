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

// The three functions below back a single toast that stays on screen and
// updates its own text while a long-running operation (repo push/pull,
// Gist publish) is in flight — showToast's fixed short duration and
// one-shot message don't fit that. Toast.svelte needs no changes to
// support this: it just renders whatever's in `toasts`, keyed by id, so
// updating an existing entry's message re-renders that same toast in
// place rather than creating a new one.
export function showProgressToast(message: string): number {
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, type: "info" }]);
  return id;
}

export function updateProgressToast(id: number, message: string) {
  toasts.update((list) => list.map((t) => (t.id === id ? { ...t, message } : t)));
}

export function finishProgressToast(id: number, message: string, type: ToastType, duration = 3200) {
  toasts.update((list) => list.map((t) => (t.id === id ? { ...t, message, type } : t)));
  setTimeout(() => dismissToast(id), duration);
}
