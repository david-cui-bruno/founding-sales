import { readFile } from 'node:fs/promises';
import type { ImportFile } from '../renderer/firmWorkspaceContract.ts';

/**
 * Choosing a CSV to import, in the main process (1.0.13).
 *
 * Until 1.0.13 the window held an `<input type="file">`, read the file with `File.text()`
 * and sent up to half a megabyte of somebody's prospect list across the bridge. It worked,
 * and it put the whole file in the renderer — the one process in this app that runs
 * untrusted-shaped code and has no business holding a customer list.
 *
 * So the dialog is macOS's, opened from here, and the text never leaves this process: the
 * window presses a button, the main process asks for a file, reads it, previews it with
 * the server and answers the Firms state. A page that cannot name a path cannot ask for
 * one, which is the same rule dialling follows.
 *
 * Nothing here imports Electron. `openDialog` is the port — `dialog.showOpenDialog` in
 * the app, a function in a test — so this is testable without a window.
 */

/** What macOS answered: the paths chosen, or none when the person cancelled. */
export interface FileChoice {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface ImportHandoffDeps {
  openDialog(): Promise<FileChoice>;
  /** Reading the file. The default is `node:fs`; a test gives its own. */
  readonly read?: (path: string) => Promise<string>;
}

/** The bound `importPreviewRequestSchema` puts on a file, in characters. */
export const MAX_IMPORT_FILE_CHARACTERS = 512 * 1024;

/** The filter the open panel shows: a CSV, or anything, because a `.txt` export is common. */
export const IMPORT_FILE_FILTERS = Object.freeze([
  { name: 'Comma-separated values', extensions: ['csv', 'txt'] },
  { name: 'All files', extensions: ['*'] },
]);

/** The file's name as a person would call it: the last path segment. */
export function fileNameOf(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export interface ImportHandoff {
  /** The file the person chose, as text and a name, or null when they cancelled. */
  choose(): Promise<ImportFile | null>;
}

export function createImportHandoff(deps: ImportHandoffDeps): ImportHandoff {
  const read = deps.read ?? (async (path: string) => await readFile(path, 'utf8'));
  return {
    async choose() {
      const chosen = await deps.openDialog();
      const path = chosen.canceled ? undefined : chosen.filePaths[0];
      if (path === undefined) return null;
      // A file this process cannot read is not a refusal the window has to render: the
      // preview it never gets is the state unchanged, which is what cancelling looks like.
      try {
        return { csv: await read(path), fileName: fileNameOf(path) };
      } catch {
        return null;
      }
    },
  };
}
