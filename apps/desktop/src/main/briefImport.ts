import { randomUUID } from 'node:crypto';
import {
  preparedBriefImportFileSchema,
  preparedBriefImportRowSchema,
  preparedBriefMatchResponseSchema,
  preparedBriefSetResultSchema,
  type PreparedBriefImportRow,
  type PreparedBriefMatch,
} from '@fss/contracts';
import type { BriefImportView } from '../shared/briefImport.ts';
import type { AuthedClient } from './authedClient.ts';
import type { FileChoice } from './importHandoff.ts';

/**
 * Importing prepared briefs from a JSON file (lane PB): Firms → Import → "Import prepared
 * briefs (JSON)…", an administrator's action.
 *
 * The CSV import's shape, for the CSV import's reasons (`importHandoff.ts`): macOS's open
 * panel is opened here, the file is read and parsed here, and the window is given a
 * preview — which firm each row names, and why a row will not be imported — never the
 * file. The briefs stay in this process until they are sent.
 *
 *   * **Preview.** Each element of the array is checked on its own against
 *     `preparedBriefImportRowSchema` (one bad row is one bad row), and the valid rows'
 *     identifiers go to `POST /firms/brief/match`, which matches them with the CSV
 *     importer's own matcher: external id, then website domain, then name; a key naming
 *     two firms is `ambiguous` and is not imported.
 *   * **Commit.** Every matched row is one `POST /firms/brief/set`, under a command id
 *     minted once at the preview, so each row has its own receipt and a second press
 *     replays what landed instead of writing it twice. A refused row keeps its reason and
 *     the rest go on (partial failure is per row). Only rows not yet saved are sent again.
 *
 * `forget()` drops the file and the preview; it runs on every identity change.
 */

/** The bound on a file, in characters: 2,000 rows of 4,000-character briefs and their sources. */
export const MAX_BRIEF_FILE_CHARACTERS = 16 * 1024 * 1024;

export const BRIEF_FILE_FILTERS = Object.freeze([
  { name: 'JSON', extensions: ['json'] },
  { name: 'All files', extensions: ['*'] },
]);

export interface BriefImportDeps {
  readonly api: AuthedClient;
  /** The session's transition counter: a commit stops when it moves. Absent in tests that never sign out. */
  readonly sessionGeneration?: () => number;
  openDialog(): Promise<FileChoice>;
  readonly read?: (path: string) => Promise<string>;
}

export interface BriefImportHost {
  state(): Promise<BriefImportView>;
  /** Ask macOS for a file, read and preview it. Cancelling is the state unchanged. */
  choose(): Promise<BriefImportView>;
  /** Sends the rows of the preview `previewId` names, and only while it is the one shown. */
  commit(input: { readonly previewId: number }): Promise<BriefImportView>;
  reset(): Promise<BriefImportView>;
  forget(): Promise<BriefImportView>;
}

/** One row as the file gave it, checked: the row, or the first field at fault. */
export type ParsedBriefRow =
  | { readonly ok: true; readonly row: PreparedBriefImportRow }
  | { readonly ok: false; readonly issue: string; readonly label: string };

export type ParsedBriefFile =
  | { readonly ok: true; readonly rows: readonly ParsedBriefRow[] }
  | { readonly ok: false; readonly error: NonNullable<BriefImportView['fileError']> };

function labelOf(raw: unknown, index: number): string {
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    for (const key of ['firm_name', 'external_id', 'website']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 300);
    }
  }
  return `Row ${String(index + 1)}`;
}

/** The file's text, as rows the preview can show. Exported for the tests and the DFW file check. */
export function parseBriefFile(text: string): ParsedBriefFile {
  if (text.length > MAX_BRIEF_FILE_CHARACTERS) return { ok: false, error: 'too_large' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not_json' };
  }
  if (!Array.isArray(value)) return { ok: false, error: 'not_array' };
  const file = preparedBriefImportFileSchema.safeParse(value);
  if (!file.success) return { ok: false, error: value.length === 0 ? 'empty' : 'too_many_rows' };
  return {
    ok: true,
    rows: file.data.map((raw, index): ParsedBriefRow => {
      const parsed = preparedBriefImportRowSchema.safeParse(raw);
      if (parsed.success) return { ok: true, row: parsed.data };
      const first = parsed.error.issues[0];
      const field = first?.path[0];
      return { ok: false, issue: typeof field === 'string' ? field : 'firm', label: labelOf(raw, index) };
    }),
  };
}

const EMPTY: BriefImportView = Object.freeze({ previewId: 0, fileName: null, fileError: null, reason: null, rows: [] });

type PendingRow = { readonly row: PreparedBriefImportRow; readonly firmId: string; readonly commandId: string };

export function createBriefImport(deps: BriefImportDeps): BriefImportHost {
  const read = deps.read ?? (async (path: string) => (await import('node:fs/promises')).readFile(path, 'utf8'));
  const sessionGeneration = deps.sessionGeneration ?? (() => 0);
  let view: BriefImportView = EMPTY;
  /**
   * The rows to send for the preview on screen, by preview index, and the id each one is
   * sent under. Replaced whole by each preview, never merged (review PB, finding 3).
   */
  let pending = new Map<number, PendingRow>();
  /** The id the next preview takes; the view carries the id of the one it shows. */
  let lastPreviewId = 0;
  /**
   * Advanced by `forget()` and `reset()`: a preview or a commit that began under an older value
   * writes nothing and sends nothing more (review PB, finding 2).
   */
  let epoch = 0;

  const clear = (): BriefImportView => {
    epoch += 1;
    view = EMPTY;
    pending = new Map();
    return view;
  };

  async function preview(fileName: string, text: string): Promise<BriefImportView> {
    lastPreviewId += 1;
    const previewId = lastPreviewId;
    const began = epoch;
    /** Still the latest preview, and nothing was forgotten since it began. */
    const current = (): boolean => previewId === lastPreviewId && began === epoch;
    const parsed = parseBriefFile(text);
    if (!parsed.ok) {
      view = { previewId, fileName, fileError: parsed.error, reason: null, rows: [] };
      pending = new Map();
      return view;
    }
    const valid = parsed.rows.flatMap((entry, index) => (entry.ok ? [{ index, row: entry.row }] : []));
    let matches: readonly PreparedBriefMatch[] = [];
    if (valid.length > 0) {
      const answer = await deps.api.read('/firms/brief/match', value => preparedBriefMatchResponseSchema.parse(value), {
        rows: valid.map(({ row }) => ({
          ...(row.external_id === undefined ? {} : { externalId: row.external_id }),
          ...(row.website === undefined ? {} : { website: row.website }),
          ...(row.firm_name === undefined ? {} : { firmName: row.firm_name }),
        })),
      });
      // A newer preview, or a forget, owns the state now: this answer writes nothing.
      if (!current()) return view;
      if (!answer.ok) {
        view = { previewId, fileName, fileError: null, reason: answer.reason.slice(0, 80), rows: [] };
        pending = new Map();
        return view;
      }
      matches = answer.value.rows;
    }
    const matchOf = new Map(valid.map(({ index }, position) => [index, matches[position]] as const));
    const rows = new Map<number, PendingRow>();
    const shown: BriefImportView = {
      previewId,
      fileName,
      fileError: null,
      reason: null,
      rows: parsed.rows.map((entry, index) => {
        if (!entry.ok) {
          return { index: index + 1, label: entry.label, status: 'invalid', issue: entry.issue, firmName: null, matchedOn: null, briefLength: 0, sourceCount: 0, result: null };
        }
        const match = matchOf.get(index) ?? { status: 'unmatched' as const };
        const label = entry.row.firm_name ?? entry.row.external_id ?? entry.row.website ?? `Row ${String(index + 1)}`;
        if (match.status === 'matched') rows.set(index + 1, { row: entry.row, firmId: match.firmId, commandId: randomUUID() });
        return {
          index: index + 1,
          label,
          status: match.status,
          issue: match.status === 'ambiguous' ? match.column : null,
          firmName: match.status === 'matched' ? match.firmName : null,
          matchedOn: match.status === 'matched' ? match.matchedOn : null,
          briefLength: entry.row.brief.length,
          sourceCount: entry.row.sources.length,
          result: null,
        };
      }),
    };
    if (!current()) return view;
    view = shown;
    pending = rows;
    return view;
  }

  return {
    async state() {
      return view;
    },
    async choose() {
      const chosen = await deps.openDialog();
      const path = chosen.canceled ? undefined : chosen.filePaths[0];
      if (path === undefined) return view;
      let text: string;
      try {
        text = await read(path);
      } catch {
        return view;
      }
      return await preview(path.split('/').at(-1) ?? path, text);
    },
    async commit(input) {
      // Exactly the rows of the preview the window shows: a commit for any other sends nothing.
      if (input.previewId !== view.previewId || view.previewId === 0) return view;
      const previewId = view.previewId;
      const rows = pending;
      const began = epoch;
      const session = sessionGeneration();
      /** Checked before every submission: a sign-out, a forget or a newer preview stops the loop. */
      const live = (): boolean => began === epoch && session === sessionGeneration() && previewId === view.previewId;
      for (const [index, entry] of rows) {
        if (!live()) return view;
        const shown = view.rows.find(row => row.index === index);
        if (shown?.result === 'saved') continue;
        const answer = await deps.api.command(
          '/firms/brief/set',
          {
            firmId: entry.firmId,
            brief: entry.row.brief,
            sources: entry.row.sources,
            observedOn: entry.row.observed_on,
            preparedBy: entry.row.prepared_by,
          },
          value => preparedBriefSetResultSchema.parse(value),
          { commandId: entry.commandId },
        );
        if (!live()) return view;
        const result = answer.ok ? 'saved' : answer.reason.slice(0, 80);
        view = { ...view, rows: view.rows.map(row => (row.index === index ? { ...row, result } : row)) };
      }
      return view;
    },
    async reset() {
      return clear();
    },
    async forget() {
      return clear();
    },
  };
}
