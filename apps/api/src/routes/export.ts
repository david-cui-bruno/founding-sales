import { exportRequestSchema } from '@fss/contracts';
import { exportFirms } from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
import { domainFilters } from './search.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * CRM export (specification 5.2, 7.2, 14.1, Appendix F).
 *
 * `POST /export/firms`. Every row is a `FirmReadDto` at the width the read matrix
 * gives this caller, and the whole export writes one `export.firms` audit event
 * (5.2: "Admin reads of message bodies, drafts, mailbox diagnostics, and exports
 * create access audit events").
 *
 * **Not a command, deliberately.** Every mutation in this API carries a command id
 * so that a replay returns the original result instead of repeating the effect.
 * That is the wrong shape here twice over: the effect worth recording is the audit
 * event, and two exports genuinely are two copies taken — a replay that answered
 * from a receipt would hide the second one from the auditor — and the result is the
 * exported data, which has no business being written into `command_receipts`.
 *
 * So an export is an audited read: authenticated, scoped, redacted by construction,
 * and recorded once each time it happens. The audit event and the read commit in the
 * same statement sequence as everything else the domain does.
 */

export const EXPORT_PATHS = ['/export/firms'] as const;

export async function routeExport(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(EXPORT_PATHS as readonly string[]).includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;

  const parsed = exportRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  const filters = domainFilters(parsed.data.filters);
  const exported = await exportFirms(scoped.context, {
    ...(parsed.data.term === undefined ? {} : { term: parsed.data.term }),
    ...(filters === undefined ? {} : { filters }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  });
  if (!exported.ok) return { status: 409, body: { status: 'refused', reason: exported.reason } };
  return { status: 200, body: exported.value };
}
