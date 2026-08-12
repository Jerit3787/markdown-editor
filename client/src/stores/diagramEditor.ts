import { writable } from "svelte/store";

export const diagramEditorOpen = writable(false);
// null = creating a new diagram; a string = editing that ref's existing diagram.
export const diagramEditorRef = writable<string | null>(null);
