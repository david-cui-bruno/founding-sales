import type { DialRefusalCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readFirm } from '../crm/firms.ts';
import type { FirmRow } from '../crm/types.ts';
import { currentCallingWindow, evaluateConfiguredCallingWindow } from '../policy/callingWindows.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { applicablePosture } from '../policy/postures.ts';
import { firstSuppressed } from '../suppression/effective.ts';
import { USABLE_CALLING_IDENTITY_SQL } from './identities.ts';
import type { EffectiveSuppression } from '../suppression/effective.ts';

/**
 * `authorizeDial` (specification 9.2).
 *
 * "`authorizeDial` is the only FSS source of an allow/refuse decision. It evaluates,
 * in order, and first refusal wins:
 *
 *   1. Effective firm, number, or relevant contact-handle suppression
 *   2. Active verified calling identity owned by the actor (since wave 2, S4.3: owned
 *      and not retired — a number is attested when it is added)
 *   3. Active unretired usable route at the displayed version (since wave 2, S4.4, a
 *      stored `candidate` phone counts as usable: numbers are usable on entry)
 *   4. Actor assignment and permission
 *   5. Known firm state and confidently established actual IANA zone
 *   6. Exactly one applicable state posture whose effective range contains database
 *      time and whose review date has not passed
 *   7. Configured weekday and local calling window in the firm's actual zone
 *   8. No applicable calling or restore pause"
 *
 * The order is the specification's, and it is not the order a programmer would pick.
 * Suppression before assignment means an unassigned salesperson is told the firm is
 * suppressed rather than that it is not theirs — which is right: the suppression is
 * the more important fact and the one that must never be worked around. The steps
 * below are numbered in the code so the order cannot drift without the numbers
 * drifting with it.
 *
 * `at` is database time, read once by the caller. Every step is decided at that one
 * instant: a posture that expires between step 6 and step 7 would otherwise produce
 * a decision that was never true.
 *
 * This function reads. It writes nothing, mints nothing, and is safe to call from a
 * card render; `authorizeDialCommand` is what turns an allow into a ticket.
 */

export type DialDecision =
  | { readonly allowed: true; readonly evidence: DialEvidence }
  | { readonly allowed: false; readonly reason: DialRefusalCode };

export interface DialEvidence {
  readonly firmId: string;
  readonly contactId: string | null;
  readonly assignedUserId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly e164: string;
  readonly callingIdentityId: string;
  readonly postureId: string;
  readonly postureRevision: number;
  readonly firmTimeZone: string;
  readonly firmLocalTime: string;
  readonly at: string;
}

export interface AuthorizeDialInput {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly routeId: string;
  /** The version the card displayed. A stale one is refused, never upgraded (9.1). */
  readonly routeVersion: number;
  readonly callingIdentityId: string;
  /** Database time, read once by the caller. */
  readonly at: string;
}

interface IdentityRow {
  readonly id: string;
  readonly owner_user_id: string | null;
  readonly usable: boolean;
  readonly [column: string]: unknown;
}

interface PhoneRouteRow {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly e164: string;
  readonly eligibility: 'candidate' | 'usable' | 'invalid' | 'retired';
  readonly version: number;
  readonly [column: string]: unknown;
}

/**
 * The phone eligibilities a dial refuses. `candidate` is not one since wave 2 (S4.4): a
 * number is usable on entry, and one an older release stored as a candidate is dialled
 * as it stands, so `route_candidate` is never answered.
 */
const ELIGIBILITY_REFUSAL: Readonly<Partial<Record<PhoneRouteRow['eligibility'], DialRefusalCode>>> = Object.freeze({
  invalid: 'route_invalid',
  retired: 'route_retired',
});

const refused = (reason: DialRefusalCode): DialDecision => ({ allowed: false, reason });

/**
 * Step 1's keys: the firm, the number about to be dialed, and every other phone
 * handle of the same contact.
 *
 * "Effective firm, number, or relevant contact-handle suppression." The third is the
 * one that is easy to miss: a prospect who asked to stop on their mobile has not
 * given permission for their desk line, and both are the same person.
 */
export async function suppressionKeys(
  context: RepositoryContext,
  firm: FirmRow,
  route: Pick<PhoneRouteRow, 'e164' | 'contact_id'> | null,
  contactId: string | undefined,
): Promise<readonly { readonly scope: 'firm' | 'handle'; readonly canonicalKey: string }[]> {
  const keys: { scope: 'firm' | 'handle'; canonicalKey: string }[] = [
    { scope: 'firm', canonicalKey: firm.id.toLowerCase() },
  ];
  if (route !== null) keys.push({ scope: 'handle', canonicalKey: route.e164 });
  const contact = contactId ?? route?.contact_id ?? null;
  if (contact !== null) {
    const { rows } = await context.db.query<{ e164: string }>(
      'SELECT e164 FROM phone_routes WHERE workspace_id = $1 AND firm_id = $2 AND contact_id = $3',
      [context.scope.workspaceId, firm.id, contact],
    );
    for (const row of rows) keys.push({ scope: 'handle', canonicalKey: row.e164 });
  }
  return keys;
}

function suppressionRefusal(suppression: EffectiveSuppression): DialRefusalCode {
  return suppression.scope === 'firm' ? 'firm_suppressed' : 'handle_suppressed';
}

export async function authorizeDial(
  context: RepositoryContext,
  input: AuthorizeDialInput,
): Promise<DialDecision> {
  const actor = context.scope.actor;

  const firm = await readFirm(context, input.firmId);
  if (firm === null || firm.status === 'merged') return refused('firm_unknown');

  const routeResult = await context.db.query<PhoneRouteRow>(
    'SELECT id, firm_id, contact_id, e164, eligibility, version FROM phone_routes WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.routeId],
  );
  const route = routeResult.rows[0] ?? null;

  // ---- 1. Suppression -----------------------------------------------------
  const suppression = await firstSuppressed(
    context,
    await suppressionKeys(context, firm, route, input.contactId),
  );
  if (suppression !== null) return refused(suppressionRefusal(suppression));

  // ---- 2. Calling identity ------------------------------------------------
  // Attested when added since wave 2 (S4.3): a number is the actor's own and not retired,
  // and one an older release registered without an attestation is usable as it stands.
  // `identity_unverified` is never answered.
  const identityResult = await context.db.query<IdentityRow>(
    `SELECT id, owner_user_id, ${USABLE_CALLING_IDENTITY_SQL} AS usable
       FROM calling_identities WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.callingIdentityId],
  );
  const identity = identityResult.rows[0];
  if (identity === undefined) return refused('identity_missing');
  // "Null-owner identities are reserved for a future shared line and are refused
  // until shared-line entitlements exist." Named separately from `identity_not_owned`
  // because it is a product state, not a mistake by this caller.
  if (identity.owner_user_id === null) return refused('identity_shared_line_disabled');
  if (!identity.usable) return refused('identity_disabled');
  // The worker never dials. A system scope asking for a dial authorization has no
  // actor to own an identity, and "owned by the acting salesperson" cannot be true.
  if (actor.kind !== 'user') return refused('identity_not_owned');
  if (identity.owner_user_id !== actor.userId) return refused('identity_not_owned');

  // ---- 3. Route -----------------------------------------------------------
  if (route === null || route.firm_id !== firm.id) return refused('route_missing');
  // The displayed version first: a card showing version 1 of a route now at version 2
  // is looking at a number that has since been replaced or retired, and the honest
  // answer is "your card is out of date", not the new route's state.
  if (route.version !== input.routeVersion) return refused('route_version_stale');
  const ineligible = ELIGIBILITY_REFUSAL[route.eligibility];
  if (ineligible !== undefined) return refused(ineligible);
  if (input.contactId !== undefined && route.contact_id !== null && route.contact_id !== input.contactId) {
    return refused('route_missing');
  }

  // ---- 4. Assignment ------------------------------------------------------
  // Admins are not exempt. Section 9.1 requires an identity "owned by the acting
  // salesperson", and step 2 has already tied the call to this actor's own number;
  // an admin dialing someone else's firm from their own line is a call Callie made
  // without the assignee knowing.
  if (firm.assigned_user_id === null || firm.assigned_user_id !== actor.userId) return refused('not_assigned');

  // ---- 5. Firm zone -------------------------------------------------------
  // "Inability to establish it blocks calling." A firm that has never been through
  // the zone rule is refused for the same reason as one the rule could not resolve.
  if (firm.time_zone === null || firm.time_zone_confidence === null) return refused('zone_unresolved');
  if (firm.region_code === null) return refused('zone_unresolved');

  // ---- 6. State posture ---------------------------------------------------
  const posture = await applicablePosture(context, firm.region_code, input.at);
  if (posture.decision.kind === 'refused') return refused(posture.decision.reason);
  const chosen = 'posture' in posture ? posture.posture : null;
  if (chosen === null) return refused('posture_missing');

  // ---- 7. Calling window --------------------------------------------------
  const window = await currentCallingWindow(context);
  const evaluated = evaluateConfiguredCallingWindow(input.at, firm.time_zone, window);
  if (!evaluated.allowed) {
    return refused(evaluated.refusal === 'zone_unknown' ? 'zone_unresolved' : 'outside_calling_window');
  }

  // ---- 8. Pauses and other holds -----------------------------------------
  // Section 9.2 says "no applicable calling or restore pause", and section 15 makes
  // every reversible blocker a hold with a reason code. Asking `active_holds` for
  // everything blocking `dial_authorization` covers the pause, the restore, the
  // reassignment and whatever a later lane adds, and each answers with its own code
  // rather than with a generic "held".
  const holds = await listApplicableHolds(context, {
    actionKind: 'dial_authorization',
    firmId: firm.id,
    ownerUserId: actor.userId,
    channel: 'call',
  });
  const blocking = holds[0];
  if (blocking !== undefined) return refused(blocking.reasonCode as DialRefusalCode);

  return {
    allowed: true,
    evidence: {
      firmId: firm.id,
      contactId: input.contactId ?? route.contact_id,
      assignedUserId: firm.assigned_user_id,
      routeId: route.id,
      routeVersion: route.version,
      e164: route.e164,
      callingIdentityId: identity.id,
      postureId: chosen.id,
      postureRevision: chosen.revision,
      firmTimeZone: firm.time_zone,
      firmLocalTime: evaluated.localTime,
      at: input.at,
    },
  };
}
