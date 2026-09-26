import {
  IMPORT_COLUMNS,
  importCommitRequestSchema,
  importPreviewRequestSchema,
  type ImportColumn,
  type ImportCommitResult,
} from '@fss/contracts';
import { commitImportRow, previewCsvImport, type ImportPreviewRow } from '@fss/domain/crm/import.ts';
import { runCommand } from '../auth/commands.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Admin CSV import (specification 7.2, Appendix G 38).
 *
 * `POST /import/preview` validates a file and writes nothing. `POST /import/commit`
 * takes the same file again and the command ids for the rows the person chose.
 *
 * **The file, not the preview.** A preview is a value the client is holding, and a
 * commit that accepted an edited one would be committing rows the server never
 * checked. So the commit re-previews the same bytes — the preview is a pure function
 * of the file and the workspace — and commits the rows it named. A client that
 * changed a byte gets a different preview and a `row_changed` refusal for any row
 * whose content moved, because the payload hash on the receipt no longer matches.
 *
 * **One row, one command, one transaction.** Each row runs inside its own
 * `runCommand`: the receipt, the payload hash, the device and every insert the row
 * makes commit together, and a row that fails takes only its own work back. That is
 * Appendix G 38's "atomic per-row commands" and its "partial failures" at once — and
 * it is why a retry of the whole file is safe, because the rows that landed replay
 * and the rows that did not are attempted again.
 *
 * **Rows in order**. A file has a row per contact, and the first row that
 * names a firm creates it; the rows after it add their contacts to the firm that row
 * committed. So the rows are committed in row order whatever order they were asked in,
 * and each accepted row's firm id is handed to the rows after it.
 *
 * **A refusal says where.** A file refused whole names the header or the line at fault;
 * a row refused names its column, and the receipt keeps the column beside the code so a
 * replay says the same.
 *
 * Both paths are admin-only, and the domain says so rather than this file: section
 * 5.2 gives import to an administrator, and `previewCsvImport` and `commitImportRow`
 * each ask `decideAdminOnly` before they look at anything.
 */

export const IMPORT_PATHS = ['/import/preview', '/import/commit'] as const;

/**
 * The payload the receipt is hashed over: the row's own content as the server re-derived
 * it, and never its classification. A retry after the row's firm landed classifies the
 * same row differently — it now matches the firm it created — and must still replay.
 */
function payloadOf(row: ImportPreviewRow): Readonly<Record<string, unknown>> {
  return { rowNumber: row.rowNumber, firm: row.firm, contact: row.contact, routes: row.routes };
}

function fileRefused(outcome: {
  readonly reason: string;
  readonly column: string | null;
  readonly rowNumber: number | null;
}): RouteResult {
  return {
    status: 409,
    body: { status: 'refused', reason: outcome.reason, column: outcome.column, rowNumber: outcome.rowNumber },
  };
}

function columnOf(details: Readonly<Record<string, unknown>> | undefined): ImportColumn | null {
  const column = details?.['column'];
  return IMPORT_COLUMNS.find(known => known === column) ?? null;
}

export async function routeImport(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(IMPORT_PATHS as readonly string[]).includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  const scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;

  if (request.path === '/import/preview') {
    const parsed = importPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    const preview = await previewCsvImport(scoped.context, { csv: parsed.data.csv });
    if (!preview.ok) return fileRefused(preview);
    return { status: 200, body: preview.value };
  }

  const parsed = importCommitRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  // Re-derived from the bytes, under the caller's own scope, before anything commits.
  const preview = await previewCsvImport(scoped.context, { csv: parsed.data.csv });
  if (!preview.ok) return fileRefused(preview);
  const byRowNumber = new Map(preview.value.rows.map(row => [row.rowNumber, row]));

  const asked = [...parsed.data.rows].sort((left, right) => left.rowNumber - right.rowNumber);
  const seen = new Set<number>();
  /** Row number to the firm it committed, for the rows after it that belong to that firm. */
  const committed = new Map<number, string>();
  const results: ImportCommitResult[] = [];
  const refusedRow = (rowNumber: number, reason: string, replayed = false, column: ImportColumn | null = null): ImportCommitResult => ({
    rowNumber,
    status: 'refused',
    replayed,
    reason,
    firmId: null,
    column,
    outcome: null,
  });

  for (const ask of asked) {
    // One row, once. A second command for a row already committed in this request would
    // be classified against a workspace the first one has since changed.
    if (seen.has(ask.rowNumber)) {
      results.push(refusedRow(ask.rowNumber, 'row_repeated'));
      continue;
    }
    seen.add(ask.rowNumber);
    const row = byRowNumber.get(ask.rowNumber);
    if (row === undefined) {
      results.push(refusedRow(ask.rowNumber, 'row_unknown'));
      continue;
    }
    // Sequentially, not in a `Promise.all`: each row is its own transaction on the
    // request's one connection, and a later row may belong to the firm an earlier one
    // creates.
    const outcome = await runCommand(
      auth,
      principal,
      {
        commandId: ask.commandId,
        kind: 'crm.import_row',
        payload: payloadOf(row),
        clientVersion: parsed.data.clientVersion,
      },
      async context => {
        const done = await commitImportRow(context, row, { committedFirmIds: committed });
        if (done.ok) {
          return {
            status: 'accepted',
            result: { firmId: done.value.firmId, contactId: done.value.contactId, outcome: done.value.outcome },
          };
        }
        return {
          status: 'refused',
          reason: done.reason,
          ...(done.column === null ? {} : { details: { column: done.column } }),
        };
      },
    );
    if (outcome.status === 'accepted') {
      const result = outcome.result as { firmId?: unknown; outcome?: unknown } | null;
      const firmId = typeof result?.firmId === 'string' ? result.firmId : null;
      if (firmId !== null) committed.set(row.rowNumber, firmId);
      results.push({
        rowNumber: ask.rowNumber,
        status: 'accepted',
        replayed: outcome.replayed,
        reason: null,
        firmId,
        column: null,
        // An older receipt kept only the firm id.
        outcome: result?.outcome === 'created' || result?.outcome === 'attached' ? result.outcome : null,
      });
    } else {
      results.push(refusedRow(ask.rowNumber, outcome.reason, outcome.replayed, columnOf(outcome.details)));
    }
  }

  return {
    status: 200,
    body: {
      results,
      counts: {
        accepted: results.filter(result => result.status === 'accepted').length,
        refused: results.filter(result => result.status === 'refused').length,
      },
    },
  };
}
