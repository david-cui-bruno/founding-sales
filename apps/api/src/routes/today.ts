import { TODAY_CARD_VERSION, todayFirmRequestSchema } from '@fss/contracts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { readTodayFirm, readTodayList, todayFirmVersion1 } from '@fss/domain/today/dto.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Today list (specification 8.2, 14.1).
 *
 * The exact paths this module owns, for G5b's route registry. Exact rather than a
 * `/today` prefix, which is what every new endpoint should be: the registry refuses
 * two claims on one path, and that guarantee is only as sharp as the claim.
 *
 * `GET /today` is a GET and the expansion is a POST, which looks inconsistent and is
 * not. `docs/decisions/g3b-reads-are-posts.md` puts a read in a POST when the *request*
 * would otherwise carry a prospect's name, number or address through a load-balancer
 * access log. The list request carries nothing at all: the caller is the session and
 * the date is the server's. The expansion carries a firm id, which is not personal
 * data either — it is a POST for the reason G3b gave `/crm/firm-page`, that a rule
 * which applies to some of a family is a rule somebody gets wrong on the rest.
 *
 * Neither route decides who may see what. `readTodayList` does, from the scope's own
 * role, because 8.2's "Admins see all entries; salespeople see their own" is a
 * property of the read and not of the transport.
 */
export const TODAY_PATHS: readonly string[] = ['/today', '/today/firm'];

/*
 * `cardVersion: 2` (`todayFirmRequestSchema` in `@fss/contracts`) asks for the tasks
 * with their identities: the callback, the step execution, the call that needs a
 * callback time, and the pause. Without it the card is the first shape exactly,
 * because an older desktop parses the card with a strict schema and
 * would refuse a field it has never heard of.
 */

export async function routeToday(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/today')) return null;
  // `/today/snooze` and `/today/pause/release` are the snooze module's; the registry
  // routes them there and this guard keeps the direct caller honest.
  if (!TODAY_PATHS.includes(request.path)) return null;

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;

  if (request.path === '/today') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    // Database time, so the business date the Mac caches is the one the 05:00 job
    // built and not the one this task's clock believes in (Appendix D).
    return { status: 200, body: await readTodayList(context, { now: await databaseNow(context) }) };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  const parsed = todayFirmRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  const page = await readTodayFirm(context, { firmId: parsed.data.firmId, now: await databaseNow(context) });
  // A firm with no card today and a colleague's firm are the same answer on purpose:
  // telling a salesperson that somebody else's firm has work on it is a read Appendix
  // F's first row does not grant.
  if (page === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  return { status: 200, body: parsed.data.cardVersion === TODAY_CARD_VERSION ? page : todayFirmVersion1(page) };
}
