import type { DialRefusalCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readFirm } from '../crm/firms.ts';
import { currentCallingWindow, evaluateConfiguredCallingWindow } from '../policy/callingWindows.ts';
import { databaseNow } from '../policy/clock.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { applicablePosture } from '../policy/postures.ts';
import { firstSuppressed } from '../suppression/effective.ts';
import { suppressionKeys } from './authorize.ts';

/**
 * "Can I call this firm now?" as advice, not a ticket (wave 2, S4.5).
 *
 * The Mac shows the answer on the card, opens `tel:` itself when the person presses Call,
 * and logs the call afterwards with `POST /calls/log`, which needs no ticket. So this is a
 * read: it writes nothing, mints nothing, and answers every reason that applies rather
 * than the first, so a card can say "outside the calling window, and the state is not on
 * your list" in one go.
 *
 * The questions are `authorizeDial`'s, in 9.2's order, less the ones that were about the
 * ticket rather than the call — the calling identity (the phone app places the call on
 * whatever line it has) and the route version the card displayed:
 *
 *   * suppression of the firm, the number, or another number of the same contact —
 *     `firm_suppressed`, `handle_suppressed` (a "do not call" outcome records one);
 *   * the number, when one is named: this firm's, and not `invalid` or `retired`
 *     (`route_missing`, `route_invalid`, `route_retired`) — a stored candidate is usable;
 *   * assignment — `not_assigned`;
 *   * the firm's zone — `zone_unresolved`, which also leaves the window unanswerable;
 *   * the state on the "OK to call" list — `posture_missing`, `posture_overlapping`;
 *   * the configured calling window in the firm's zone — `outside_calling_window`;
 *   * every open hold blocking `dial_authorization` — a pause, a restore, an uncertain
 *     reply — each by its own reason code.
 *
 * A firm this caller may not see is `null`, the same answer as one that does not exist:
 * a salesperson learns nothing about a colleague's firm by asking.
 */

export interface DialAdvice {
  readonly firmId: string;
  readonly callable: boolean;
  /** Every reason that applies, in 9.2's order, each once. Empty when callable. */
  readonly reasons: readonly DialRefusalCode[];
  readonly routeId: string | null;
  readonly e164: string | null;
  /** The URI the Mac opens, for a named number that is this firm's and not invalid or retired. */
  readonly telUri: string | null;
  readonly firmTimeZone: string | null;
  /** The firm's local clock at the moment of the advice, `HH:MM`, when the zone is known. */
  readonly firmLocalTime: string | null;
  /** Database time the advice was taken at. */
  readonly at: string;
}

interface AdviceRouteRow {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly e164: string;
  readonly eligibility: 'candidate' | 'usable' | 'invalid' | 'retired';
  readonly [column: string]: unknown;
}

export async function adviseDial(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly routeId?: string | undefined; readonly at?: string | undefined },
): Promise<DialAdvice | null> {
  const actor = context.scope.actor;
  const firm = await readFirm(context, input.firmId);
  if (firm === null || firm.status === 'merged') return null;
  // A colleague's firm is not this salesperson's to ask about (Appendix F row 1).
  if (actor.kind === 'user' && actor.role !== 'admin' && firm.assigned_user_id !== actor.userId) return null;

  const at = input.at ?? (await databaseNow(context));
  const reasons: DialRefusalCode[] = [];
  const add = (reason: DialRefusalCode): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  let route: AdviceRouteRow | null = null;
  if (input.routeId !== undefined) {
    const { rows } = await context.db.query<AdviceRouteRow>(
      'SELECT id, firm_id, contact_id, e164, eligibility FROM phone_routes WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, input.routeId],
    );
    const found = rows[0];
    route = found !== undefined && found.firm_id === firm.id ? found : null;
  }

  // Suppression: the firm as a whole, then the number and the contact's other numbers.
  const keys = await suppressionKeys(context, firm, route, undefined);
  const firmKeys = keys.filter(key => key.scope === 'firm');
  const handleKeys = keys.filter(key => key.scope === 'handle');
  if ((await firstSuppressed(context, firmKeys)) !== null) add('firm_suppressed');
  if ((await firstSuppressed(context, handleKeys)) !== null) add('handle_suppressed');

  if (input.routeId !== undefined) {
    if (route === null) add('route_missing');
    else if (route.eligibility === 'invalid') add('route_invalid');
    else if (route.eligibility === 'retired') add('route_retired');
  }

  if (actor.kind !== 'user' || firm.assigned_user_id !== actor.userId) add('not_assigned');

  const zoneKnown = firm.time_zone !== null && firm.time_zone_confidence !== null && firm.region_code !== null;
  let firmLocalTime: string | null = null;
  if (!zoneKnown) {
    add('zone_unresolved');
  } else {
    const posture = await applicablePosture(context, firm.region_code ?? '', at);
    if (posture.decision.kind === 'refused') add(posture.decision.reason);
    const window = evaluateConfiguredCallingWindow(at, firm.time_zone, await currentCallingWindow(context));
    firmLocalTime = window.localTime;
    if (!window.allowed) add(window.refusal === 'zone_unknown' ? 'zone_unresolved' : 'outside_calling_window');
  }

  const holds = await listApplicableHolds(context, {
    actionKind: 'dial_authorization',
    firmId: firm.id,
    ...(firm.assigned_user_id === null ? {} : { ownerUserId: firm.assigned_user_id }),
    channel: 'call',
  });
  for (const hold of holds) add(hold.reasonCode as DialRefusalCode);

  const dialable = route !== null && route.eligibility !== 'invalid' && route.eligibility !== 'retired';
  return {
    firmId: firm.id,
    callable: reasons.length === 0,
    reasons,
    routeId: route?.id ?? null,
    e164: route?.e164 ?? null,
    telUri: dialable && route !== null ? `tel:${route.e164}` : null,
    firmTimeZone: firm.time_zone,
    firmLocalTime,
    at,
  };
}
