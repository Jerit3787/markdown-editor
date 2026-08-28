import { writable } from "svelte/store";

interface GistVisibilityRequest {
  resolve: (visibility: "public" | "secret" | null) => void;
}

export const gistVisibilityRequest = writable<GistVisibilityRequest | null>(null);

export function chooseGistVisibility(): Promise<"public" | "secret" | null> {
  return new Promise((resolve) => {
    gistVisibilityRequest.set({ resolve });
  });
}
