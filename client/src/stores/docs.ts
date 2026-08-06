// Presentational state for DocList.svelte. app.ts stays the source of
// truth for the actual docs array/localStorage persistence/doc CRUD — this
// is just what its renderDocList() pushes out after every mutation, so the
// list can be rendered declaratively instead of rebuilt with innerHTML.
import { writable } from "svelte/store";
import type { Doc } from "../types";

export const docsStore = writable<Doc[]>([]);
export const activeIdStore = writable<string | null>(null);
// The active doc's live CodeMirror content, pushed on every editor change
// (undebounced) — doc.content itself only syncs from CodeMirror on the
// debounced save, which would make DocList.svelte's per-row heading
// outline lag ~400ms behind typing for whichever doc is currently open.
export const activeDocContent = writable("");
