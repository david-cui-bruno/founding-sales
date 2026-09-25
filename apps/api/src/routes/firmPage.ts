import { FIRM_PAGE_VERSION, firmPageRequestSchema } from '@fss/contracts';
import { readFirmPage } from '@fss/domain/crm';
import { REFUSAL_STATUS, contextForPrincipal, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Everything the desktop Firm page shows, in one read (specification 7.2, 7.3, 8.1,
 * 14.1, 15 and Appendix F).
 *
 * `POST /crm/firm-page`. G3a's `GET /firms/<id>` stays exactly as it is and returns
 * `FirmReadDto`; this adds the three things a page needs and a record read does not
 * — the opportunity's control mode, the stage history, and the holds — and it is a
 * separate path rather than a widening of the record read so that a caller who
 * wants a firm still gets a firm.
 *
 * Every one of the three is detail-class. `readFirmPage` decides that, not this
 * file: a colleague gets the narrow read and no empty lists, because an empty list
 * would say there is nothing to show rather than that this caller may not see it.
 */

export const FIRM_PAGE_PATHS = ['/crm/firm-page'] as const;

export async function routeFirmPage(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(FIRM_PAGE_PATHS as readonly string[]).includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;

  const parsed = firmPageRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  // Lane g90: `pageVersion: 2` puts each route's technical validation on it. Without it
  // the answer is the shape an installed 1.0.5 parses strictly.
  const page = await readFirmPage(scoped.context, {
    firmId: parsed.data.firmId,
    routeValidation: parsed.data.pageVersion === FIRM_PAGE_VERSION,
  });
  // `firm_unknown` is a 404 with the same redacted sentence every unmounted path
  // gets: a firm in another workspace and a firm that never existed are one answer.
  if (!page.ok) {
    return page.reason === 'firm_unknown'
      ? { status: REFUSAL_STATUS.not_found, body: redactError('not_found') }
      : { status: 409, body: { status: 'refused', reason: page.reason } };
  }
  return { status: 200, body: page.value };
}
