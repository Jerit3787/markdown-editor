// Presentational state for SaveToDriveDialog.svelte — the first-save
// filename + optional destination folder. Mirrors the Gist visibility
// dialog pattern: a promise the modal resolves.
import { writable } from "svelte/store";

export interface DriveExportChoice {
  name: string;
  parentFolderId?: string;
  parentFolderName?: string;
}

interface DriveExportRequest {
  defaultName: string;
  resolve: (choice: DriveExportChoice | null) => void;
}

export const driveExportRequest = writable<DriveExportRequest | null>(null);

export function chooseDriveExport(defaultName: string): Promise<DriveExportChoice | null> {
  return new Promise((resolve) => {
    driveExportRequest.set({ defaultName, resolve });
  });
}
