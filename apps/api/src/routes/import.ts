import { importCommitRequestSchema, importPreviewRequestSchema, type ImportCommitResult } from '@fss/contracts';
import { commitImportRow, previewCsvImport, type ImportPreviewRow } from '@fss/domain/crm';
import { runCommand } from '../auth/index.ts';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
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
 * Both paths are admin-only, and the domain says so rather than this file: section
 * 5.2 gives import to an administrator, and `previewCsvImport` and `commitImportRow`
 * each ask `decideAdminOnly` before they look at anything.
 */

export const IMPORT_PATHS = ['/import/preview', '/import/commit'] as const;

/** The payload the receipt is hashed over: the row as the server re-derived it. */
function payloadOf(row: ImportPreviewRow): Readonly<Record<string, unknown>> {
  return { rowNumber: row.rowNumber, firm: row.firm, contact: row.contact, routes: row.routes };
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
    if (!preview.ok) return { status: 409, body: { status: 'refused', reason: preview.reason } };
    return { status: 200, body: preview.value };
  }

  const parsed = importCommitRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  // Re-derived from the bytes, under the caller's own scope, before anything commits.
  const preview = await previewCsvImport(scoped.context, { csv: parsed.data.csv });
  if (!preview.ok) return { status: 409, body: { status: 'refused', reason: preview.reason } };
  const byRowNumber = new Map(preview.value.rows.map(row => [row.rowNumber, row]));

  const results: ImportCommitResult[] = [];
  for (const asked of parsed.data.rows) {
    const row = byRowNumber.get(asked.rowNumber);
    if (row === undefined) {
      results.push({ rowNumber: asked.rowNumber, status: 'refused', replayed: false, reason: 'row_unknown', firmId: null });
      continue;
    }
    // Sequentially, not in a `Promise.all`: `auth.db` is one connection, each row is
    // its own transaction on it, and two overlapping transactions on one backend is
    // not a thing PostgreSQL offers.
    const outcome = await runCommand(
      auth,
      principal,
      {
        commandId: asked.commandId,
        kind: 'crm.import_row',
        payload: payloadOf(row),
        clientVersion: parsed.data.clientVersion,
      },
      async context => {
        const committed = await commitImportRow(context, row);
        if (committed.ok) return { status: 'accepted', result: { firmId: committed.value.firmId } };
        return { status: 'refused', reason: committed.reason };
      },
    );
    results.push(
      outcome.status === 'accepted'
        ? {
            rowNumber: asked.rowNumber,
            status: 'accepted',
            replayed: outcome.replayed,
            reason: null,
            firmId: (outcome.result as { firmId: string } | null)?.firmId ?? null,
          }
        : {
            rowNumber: asked.rowNumber,
            status: 'refused',
            replayed: outcome.replayed,
            reason: outcome.reason,
            firmId: null,
          },
    );
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
