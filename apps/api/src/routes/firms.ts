import {
  createFirmCommandSchema,
  reassignFirmCommandSchema,
  recordEvidenceCommandSchema,
  resolveFirmZoneCommandSchema,
  updateFirmCommandSchema,
} from '@fss/contracts';
import {
  createFirm,
  listFirmsForActor,
  readFirmForActor,
  reassignFirm,
  recordEvidence,
  resolveZoneForFirm,
  updateFirm,
} from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal, runCrmCommand } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Firm routes (specification 7.2, 9.2, 14.1, Appendix A, Appendix F).
 *
 * * `GET  /firms` — every firm at identity visibility.
 * * `GET  /firms/:id` — one firm at whatever visibility Appendix F gives this caller.
 * * `POST /firms/create`, `/firms/update`, `/firms/reassign`, `/firms/resolve-zone`,
 *   `/firms/evidence` — commands, all through `runCommand`.
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
    case '/firms/create':
      return await runCrmCommand(deps, createFirmCommandSchema, 'firm.created', async (repository, body) =>
        await createFirm(repository, {
          name: body.name,
          website: body.website,
          addressLine: body.addressLine,
          locality: body.locality,
          regionCode: body.regionCode,
          postalCode: body.postalCode,
          countryCode: body.countryCode,
          assignedUserId: body.assignedUserId,
          externalId: body.externalId,
          commandId: body.commandId,
        }),
      );
    case '/firms/update':
      return await runCrmCommand(deps, updateFirmCommandSchema, 'firm.updated', async (repository, body) =>
        await updateFirm(repository, { firmId: body.firmId, patch: body.patch }),
      );
    case '/firms/reassign':
      return await runCrmCommand(deps, reassignFirmCommandSchema, 'firm.reassigned', async (repository, body) =>
        await reassignFirm(repository, {
          firmId: body.firmId,
          toUserId: body.toUserId,
          reason: body.reason,
          commandId: body.commandId,
        }),
      );
    case '/firms/resolve-zone':
      return await runCrmCommand(deps, resolveFirmZoneCommandSchema, 'firm.zone_resolved', async (repository, body) =>
        await resolveZoneForFirm(repository, { firmId: body.firmId, recordedZone: body.recordedZone }),
      );
    case '/firms/evidence':
      return await runCrmCommand(deps, recordEvidenceCommandSchema, 'firm.evidence_recorded', async (repository, body) =>
        await recordEvidence(repository, {
          firmId: body.firmId,
          contactId: body.contactId,
          provider: body.provider,
          sourceReference: body.sourceReference,
          contentHash: body.contentHash,
          confidence: body.confidence,
        }),
      );
    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}
