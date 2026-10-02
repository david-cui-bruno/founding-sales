import { randomUUID } from 'node:crypto';
import {
  PREPARED_BRIEF_LIMITS,
  preparedBriefImportFileSchema,
  preparedBriefImportResultSchema,
  preparedBriefImportRowSchema,
  preparedBriefMatchResponseSchema,
  type PreparedBriefImportRow,
  type PreparedBriefMatch,
} from '@fss/contracts';
import type { BriefImportView } from '../shared/briefImport.ts';
import type { AuthedClient } from './authedClient.ts';
import type { BridgeIdentity } from './identityReset.ts';
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
 *     identifiers go to `POST /firms/brief/match`, the CSV importer's own matcher. Each
 *     preview has an id; an answer for an older one writes nothing (review PB, finding 3).
 *   * **Commit (design reset I1).** ONE `POST /firms/brief/import` with the valid rows of the
 *     preview on screen, under a command id minted at that preview. The server matches and
 *     writes them in one transaction and answers each row's outcome; a second press replays
 *     the same id. There is no row loop here and nothing to abort.
 *   * **Identity.** The host keys its state by its own generation, which `forget()` advances,
 *     and offers it to `guardIdentity` (`identity`): an answer that began under an older
 *     generation writes nothing and never clears the newer state.
 *   * While a commit is on the wire `choose()` and `reset()` refuse (the state unchanged), and
 *     the window shows them disabled.
 */

/** The bound on a file, in characters: 2,000 rows of 4,000-character briefs and their sources. */
export const MAX_BRIEF_FILE_CHARACTERS = 16 * 1024 * 1024;

/** The import request must fit the API's 1 MiB body bound, with room for the envelope. */
export const MAX_IMPORT_REQUEST_CHARACTERS = 1000 * 1024;

export const BRIEF_FILE_FILTERS = Object.freeze([
  { name: 'JSON', extensions: ['json'] },
  { name: 'All files', extensions: ['*'] },
]);

export interface BriefImportDeps {
  readonly api: AuthedClient;
  openDialog(): Promise<FileChoice>;
  readonly read?: (path: string) => Promise<string>;
}

export interface BriefImportHost {
  state(): Promise<BriefImportView>;
  /** Ask macOS for a file, read and preview it. Cancelling, or a commit in flight, is the state unchanged. */
  choose(): Promise<BriefImportView>;
  /** One import command with the rows of the preview `previewId` names, only while it is the one shown. */
  commit(input: { readonly previewId: number }): Promise<BriefImportView>;
  reset(): Promise<BriefImportView>;
  forget(): Promise<BriefImportView>;
  readonly identity: BridgeIdentity;
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

const EMPTY: BriefImportView = Object.freeze({ previewId: 0, fileName: null, fileError: null, reason: null, committing: false, committed: false, rows: [] });

export function createBriefImport(deps: BriefImportDeps): BriefImportHost {
  const read = deps.read ?? (async (path: string) => (await import('node:fs/promises')).readFile(path, 'utf8'));
  let view: BriefImportView = EMPTY;
  /** The valid rows of the preview on screen, with their 1-based place in the file. */
  let rows: readonly { readonly index: number; readonly row: PreparedBriefImportRow }[] = [];
  /** The import command's id, minted with the preview: a second press replays it. */
  let commandId = '';
  /** The id the next preview takes; the view carries the id of the one it shows. */
  let lastPreviewId = 0;
  /** This host's identity generation: `forget()` advances it. */
  let generation = 0;

  const forget = async (): Promise<BriefImportView> => {
    generation += 1;
    view = EMPTY;
    rows = [];
    commandId = '';
    return await Promise.resolve(view);
  };

  async function preview(fileName: string, text: string): Promise<BriefImportView> {
    lastPreviewId += 1;
    const previewId = lastPreviewId;
    const mine = generation;
    /** Still the latest preview, under the same identity. */
    const current = (): boolean => previewId === lastPreviewId && mine === generation && !view.committing;
    const parsed = parseBriefFile(text);
    const valid = parsed.ok ? parsed.rows.flatMap((entry, index) => (entry.ok ? [{ index: index + 1, row: entry.row }] : [])) : [];
    const fileError: BriefImportView['fileError'] = !parsed.ok
      ? parsed.error
      : valid.length > PREPARED_BRIEF_LIMITS.importCommandRows
        ? 'too_many_rows'
        : JSON.stringify(valid.map(entry => entry.row)).length > MAX_IMPORT_REQUEST_CHARACTERS
          ? 'too_large'
          : null;
    if (!parsed.ok || fileError !== null) {
      view = { ...EMPTY, previewId, fileName, fileError };
      rows = [];
      return view;
    }
    let matches: readonly PreparedBriefMatch[] = [];
    if (valid.length > 0) {
      const answer = await deps.api.read('/firms/brief/match', value => preparedBriefMatchResponseSchema.parse(value), {
        rows: valid.map(({ row }) => ({
          ...(row.external_id === undefined ? {} : { externalId: row.external_id }),
          ...(row.website === undefined ? {} : { website: row.website }),
          ...(row.firm_name === undefined ? {} : { firmName: row.firm_name }),
        })),
      });
      if (!current()) return view;
      if (!answer.ok) {
        view = { ...EMPTY, previewId, fileName, reason: answer.reason.slice(0, 80) };
        rows = [];
        return view;
      }
      matches = answer.value.rows;
    }
    const matchOf = new Map(valid.map(({ index }, position) => [index, matches[position]] as const));
    if (!current()) return view;
    rows = valid;
    commandId = randomUUID();
    view = {
      ...EMPTY,
      previewId,
      fileName,
      rows: parsed.rows.map((entry, position) => {
        const index = position + 1;
        if (!entry.ok) {
          return { index, label: entry.label, status: 'invalid', issue: entry.issue, firmName: null, matchedOn: null, briefLength: 0, sourceCount: 0, result: null };
        }
        const match = matchOf.get(index) ?? { status: 'unmatched' as const };
        return {
          index,
          label: entry.row.firm_name ?? entry.row.external_id ?? entry.row.website ?? `Row ${String(index)}`,
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
    return view;
  }

  return {
    identity: {
      current: () => generation,
      async forgetIfCurrent(since: number): Promise<BriefImportView> {
        // A late answer clears only the generation it began under; a newer one is left alone.
        if (since === generation) return await forget();
        return view;
      },
    },
    async state() {
      return await Promise.resolve(view);
    },
    async choose() {
      if (view.committing) return view;
      const chosen = await deps.openDialog();
      const path = chosen.canceled ? undefined : chosen.filePaths[0];
      if (path === undefined || view.committing) return view;
      let text: string;
      try {
        text = await read(path);
      } catch {
        return view;
      }
      if (view.committing) return view;
      return await preview(path.split('/').at(-1) ?? path, text);
    },
    async commit(input) {
      // Exactly the preview the window shows, once at a time.
      if (input.previewId !== view.previewId || view.previewId === 0 || view.committing || view.committed || rows.length === 0) return view;
      const mine = generation;
      const previewId = view.previewId;
      const sent = rows;
      view = { ...view, committing: true, reason: null };
      const answer = await deps.api.command(
        '/firms/brief/import',
        { rows: sent.map(entry => entry.row) },
        value => preparedBriefImportResultSchema.parse(value),
        { commandId },
      );
      // An answer from an older identity writes nothing (design reset I1).
      if (mine !== generation || previewId !== view.previewId) return view;
      if (!answer.ok) {
        view = { ...view, committing: false, reason: answer.reason.slice(0, 80) };
        return view;
      }
      const outcome = new Map(answer.value.rows.map(result => [sent[result.index - 1]?.index, result.status] as const));
      view = {
        ...view,
        committing: false,
        committed: true,
        rows: view.rows.map(row => (outcome.has(row.index) ? { ...row, result: outcome.get(row.index) ?? null } : row)),
      };
      return view;
    },
    async reset() {
      if (view.committing) return view;
      return await forget();
    },
    forget,
  };
}
