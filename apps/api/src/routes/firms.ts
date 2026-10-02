import {
  clearPreparedBriefCommandSchema,
  preparedBriefImportCommandSchema,
  preparedBriefMatchRequestSchema,
  recordEvidenceCommandSchema,
  resolveFirmZoneCommandSchema,
  setPreparedBriefCommandSchema,
} from '@fss/contracts';
import { listFirmsForActor, readFirmForActor } from '@fss/domain/crm/dto.ts';
import { recordEvidence } from '@fss/domain/crm/evidence.ts';
import { resolveZoneForFirm } from '@fss/domain/crm/firms.ts';
import {
  clearPreparedBrief,
  importPreparedBriefs,
  matchPreparedBriefRows,
  readPreparedBrief,
  setPreparedBrief,
} from '@fss/domain/crm/preparedBriefs.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Firm routes (specification 7.2, 9.2, 14.1, Appendix A, Appendix F).
 *
 * * `GET  /firms` — every firm at identity visibility.
 * * `GET  /firms/:id` — one firm at whatever visibility Appendix F gives this caller.
 * * `POST /firms/resolve-zone`, `/firms/evidence` — commands, through `runCommand`.
 * * `POST /firms/brief/set`, `/firms/brief/clear` — a firm's prepared brief (lane PB,
 *   migration 0038), commands through `runCommand`; the answer and the audit row carry a
 *   length and a count, never the text. `POST /firms/brief/match` — admin only and
 *   read-only: which firm each row of a prepared-brief file names, by the CSV importer's
 *   matcher. `POST /firms/brief/import` — admin only: a whole file of at most 100 rows as one
 *   atomic, idempotent command (design reset I1).
 *
 *   Set and clear answer the brief as it is stored after the command (design reset I2), read
 *   once it has committed and added to the answer, never kept on the receipt: a receipt
 *   outlives a deletion, and the brief text can name a person.
 *   (`/firms/create`, `/firms/update` and `/firms/reassign` had no caller and went in
 *   wave 2, S6: the Mac adds a firm through `/crm/firms/add` or an import.)
 *
 * The read is the interesting one: it returns a discriminated DTO rather than a row
 * with fields blanked out, so a salesperson reading a colleague's firm gets an object
 * that has no field a note could be in. The audit event for an admin's wide read is
 * written by the domain command, not here, because the same rule has to hold for a
 * read that arrives through an export or a job.
 */

const FIRM_PATH = /^\/firms\/([0-9a-fA-F-]{36})$/u;

export async function routeFirms(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/firms')) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  const scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;
  const deps = { auth, request, principal };

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (request.path === '/firms') {
      return { status: 200, body: { firms: await listFirmsForActor(context, { limit: 200 }) } };
    }
    const match = FIRM_PATH.exec(request.path);
    if (match !== null) {
      const firmId = match[1] ?? '';
      const read = await readFirmForActor(context, { firmId });
      if (!read.ok) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
      return { status: 200, body: read.value };
    }
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/firms/resolve-zone':
      return await runRouteCommand(deps, resolveFirmZoneCommandSchema, 'firm.zone_resolved', async (repository, body) =>
        await resolveZoneForFirm(repository, { firmId: body.firmId, recordedZone: body.recordedZone }),
      );
    case '/firms/evidence':
      return await runRouteCommand(deps, recordEvidenceCommandSchema, 'firm.evidence_recorded', async (repository, body) =>
        await recordEvidence(repository, {
          firmId: body.firmId,
          contactId: body.contactId,
          provider: body.provider,
          sourceReference: body.sourceReference,
          contentHash: body.contentHash,
          confidence: body.confidence,
        }),
      );
    case '/firms/brief/set':
      return await withStoredBrief(
        context,
        await runRouteCommand(deps, setPreparedBriefCommandSchema, 'firm.prepared_brief_set', async (repository, body) =>
          await setPreparedBrief(repository, {
            firmId: body.firmId,
            brief: body.brief,
            sources: body.sources,
            observedOn: body.observedOn,
            preparedBy: body.preparedBy,
          }),
        ),
      );
    case '/firms/brief/clear':
      return await withStoredBrief(
        context,
        await runRouteCommand(deps, clearPreparedBriefCommandSchema, 'firm.prepared_brief_cleared', async (repository, body) =>
          await clearPreparedBrief(repository, { firmId: body.firmId }),
        ),
      );
    case '/firms/brief/import':
      return await runRouteCommand(deps, preparedBriefImportCommandSchema, 'firm.prepared_briefs_imported', async (repository, body) =>
        await importPreparedBriefs(repository, { rows: body.rows }),
      );
    case '/firms/brief/match': {
      const parsed = preparedBriefMatchRequestSchema.safeParse(request.body);
      if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
      const matched = await matchPreparedBriefRows(context, parsed.data);
      if (!matched.ok) return { status: 409, body: { status: 'refused', reason: matched.reason } };
      return { status: 200, body: { rows: matched.value } };
    }
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}

/**
 * An accepted set or clear, with the firm's brief as it is stored now added to its result
 * (design reset I2). Read after the command's transaction committed, so a replay answers the
 * brief as it is, and the receipt never holds the text.
 */
async function withStoredBrief(context: RepositoryContext, reply: RouteResult): Promise<RouteResult> {
  if (reply.status !== 200) return reply;
  const body = reply.body as { readonly result?: { readonly firmId?: unknown } } | null;
  const firmId = body?.result?.firmId;
  if (body === null || typeof firmId !== 'string') return reply;
  return { ...reply, body: { ...body, result: { ...body.result, brief: await readPreparedBrief(context, firmId) } } };
}
