import { isKnownTimeZone } from '../src/rules/localClock.ts';
import { isUsStateCode } from '../src/rules/statePosture.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockTodayForFirmChange, refreshTodayForFirm } from '../today/build.ts';
import { readFirmBasics, type FirmBasicsDto } from '../today/dto.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { decideFirmMutation } from './authorization.ts';
import { loadFirmForUpdate, resolveZoneForFirm, updateFirm, type FirmPatch } from './firms.ts';
import { canonicalE164 } from './import.ts';
import { addPhoneRoute, retireRoute } from './routes.ts';
import { FIRM_BASICS_FIELDS, type CrmRefusalCode, type FIRM_BASICS_ISSUE_CODES } from '@fss/contracts';

/**
 * A firm's calling basics — its number, state, locality and time zone — edited from
 * Today or the firm page (slice S2).
 *
 * These are the four things a card needs before it can be called: a number to dial, and
 * a state and a zone for the posture and the calling window (9.2). Each existing command
 * does its own part, under the rules it always had: `updateFirm` writes the locality and
 * the state, `resolveZoneForFirm` records the zone (typed, or the state's default under
 * the versioned rule), `addPhoneRoute` records the number (usable on entry, wave 2 S4.4)
 * and `retireRoute` retires the one it replaces. All of them in the caller's transaction,
 * so the edit lands whole or not at all, and then `refreshTodayForFirm` puts the firm on
 * today's list with its fresh state — "missing eligibility data is explained, with the fix
 * inline", and fixed is fixed now rather than tomorrow morning.
 *
 * A value at fault is named by its field, every one at once, so the form marks them all;
 * nothing is written when any is at fault.
 */

export type FirmBasicsField = (typeof FIRM_BASICS_FIELDS)[number];
export type FirmBasicsIssueCode = (typeof FIRM_BASICS_ISSUE_CODES)[number];

export interface FirmBasicsIssue {
  readonly field: FirmBasicsField;
  readonly code: FirmBasicsIssueCode;
}

export interface UpdateFirmBasicsInput {
  readonly firmId: string;
  /**
   * The number as typed: `(214) 555-0100`, `+12145550100`. Canonicalized as an import
   * cell is (`canonicalE164`). Recorded as the firm's own line, with no contact.
   */
  readonly phone?: { readonly number: string; readonly replacesRouteId?: string | undefined } | undefined;
  /** Null clears it. */
  readonly locality?: string | null | undefined;
  /** A US state code. Null clears it, which leaves the firm uncallable (no posture applies). */
  readonly regionCode?: string | null | undefined;
  /** An IANA zone, recorded as typed. Absent with a new state: the state's default, if it has one. */
  readonly timeZone?: string | undefined;
}

export type FirmBasicsResult =
  | { readonly ok: true; readonly value: FirmBasicsDto & { readonly firmId: string; readonly routeId: string | null } }
  | { readonly ok: false; readonly reason: CrmRefusalCode; readonly issues?: readonly FirmBasicsIssue[] };

const LOCALITY_MAX = 120;

export async function updateFirmBasics(context: RepositoryContext, input: UpdateFirmBasicsInput): Promise<FirmBasicsResult> {
  // Validation first, every field, before a row is locked or written.
  const issues: FirmBasicsIssue[] = [];
  const phone = input.phone === undefined ? undefined : canonicalE164(input.phone.number);
  if (input.phone !== undefined && (phone === null || phone === undefined)) issues.push({ field: 'phone', code: 'phone_invalid' });
  const locality = input.locality === undefined ? undefined : input.locality === null ? null : input.locality.trim() || null;
  if (locality !== undefined && locality !== null && locality.length > LOCALITY_MAX) issues.push({ field: 'locality', code: 'too_long' });
  const regionCode =
    input.regionCode === undefined ? undefined : input.regionCode === null ? null : input.regionCode.trim().toUpperCase() || null;
  if (regionCode !== undefined && regionCode !== null && !isUsStateCode(regionCode)) {
    issues.push({ field: 'regionCode', code: 'region_code_invalid' });
  }
  const timeZone = input.timeZone?.trim();
  if (timeZone !== undefined && !(timeZone.length > 0 && isKnownTimeZone(timeZone))) {
    issues.push({ field: 'timeZone', code: 'time_zone_invalid' });
  }
  if (issues.length > 0) return { ok: false, reason: 'invalid_input', issues };

  return await undoingRefusal(context, async () => await writeBasics(context, input, { phone, locality, regionCode, timeZone }));
}

async function writeBasics(
  context: RepositoryContext,
  input: UpdateFirmBasicsInput,
  values: {
    readonly phone: string | null | undefined;
    readonly locality: string | null | undefined;
    readonly regionCode: string | null | undefined;
    readonly timeZone: string | undefined;
  },
): Promise<FirmBasicsResult> {
  const { phone, locality, regionCode, timeZone } = values;
  // One lock order (S2 review, finding 1; docs/greenfield/calling.md): Today's lock, then
  // the route being replaced, then the firm — `retireRoute`'s own route → firm order — and
  // only then a write. The morning build holds Today's lock while it takes firm locks.
  await lockTodayForFirmChange(context);

  // Everything that can refuse is checked before the first write (S2 review, finding 2):
  // the number being replaced must be one of this firm's own phone numbers.
  const replaced = phone === undefined || phone === null ? undefined : input.phone?.replacesRouteId;
  if (replaced !== undefined) {
    const { rows } = await context.db.query<{ firm_id: string }>(
      'SELECT firm_id FROM phone_routes WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
      [context.scope.workspaceId, replaced],
    );
    if (rows[0]?.firm_id !== input.firmId) return { ok: false, reason: 'route_unknown' };
  }

  // The firm's lock and the assignment rule, before anything else reads it.
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return { ok: false, reason: 'firm_unknown' };
  if (firm.status !== 'active') return { ok: false, reason: firm.status === 'merged' ? 'firm_merged' : 'firm_unknown' };
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return { ok: false, reason: decision.reason };

  const patch: FirmPatch = {
    ...(locality === undefined ? {} : { locality }),
    ...(regionCode === undefined ? {} : { regionCode }),
  };
  if (Object.keys(patch).length > 0) {
    const updated = await updateFirm(context, { firmId: input.firmId, patch });
    if (!updated.ok) return { ok: false, reason: updated.reason };
  }

  // The zone. A typed zone is recorded as such. A changed state re-derives the zone only
  // when nobody typed one before: a zone a person recorded is not replaced by a default.
  const stateChanged = regionCode !== undefined && regionCode !== firm.region_code;
  if (timeZone !== undefined || (stateChanged && firm.time_zone_source !== 'recorded')) {
    const zone = await resolveZoneForFirm(context, {
      firmId: input.firmId,
      ...(timeZone === undefined ? {} : { recordedZone: timeZone }),
    });
    // "Could not establish it" is a recorded fact (the reason is on the firm), not a
    // refusal of the edit: the card says "No location or time zone" and offers the field.
    if (!zone.ok && zone.reason !== 'zone_unresolved') return { ok: false, reason: zone.reason };
  }

  let routeId: string | null = null;
  if (phone !== undefined && phone !== null) {
    const added = await addPhoneRoute(context, { firmId: input.firmId, e164: phone, source: 'salesperson' });
    if (!added.ok) return { ok: false, reason: added.reason };
    routeId = added.value.id;
    // Checked above: one of this firm's own numbers, locked.
    if (replaced !== undefined && replaced !== routeId) {
      const retired = await retireRoute(context, { routeKind: 'phone', routeId: replaced, reason: 'replaced_by_salesperson' });
      if (!retired.ok) return { ok: false, reason: retired.reason };
    }
  }

  await recordCrmAuditEvent(context, {
    action: 'firm.basics_updated',
    subjectKind: 'firm',
    subjectId: input.firmId,
    detail: {
      fields: FIRM_BASICS_FIELDS.filter(field => input[field] !== undefined),
      replacedRoute: input.phone?.replacesRouteId !== undefined,
    },
  });

  await refreshTodayForFirm(context, { firmId: input.firmId });
  const basics = (await readFirmBasics(context, [input.firmId])).get(input.firmId);
  if (basics === undefined) return { ok: false, reason: 'firm_unknown' };
  return { ok: true, value: { firmId: input.firmId, routeId, ...basics } };
}

const BASICS_SAVEPOINT = 'crm_firm_basics';

/**
 * Run the edit so that a refusal undoes everything it wrote and nothing before it (S2
 * review, finding 2). The checks above the first write make a refusal after one unlikely
 * (a number `addPhoneRoute` will not record, a zone it cannot write), but a refusal that
 * left the firm half edited would still commit with its receipt through `runCommand`.
 * Inside a transaction — every command — this is a savepoint, so the refusal's receipt
 * still commits and the edit does not; outside one (a test on an autocommit session) the
 * edit is its own transaction. An exception rolls back and propagates. The pattern is
 * `dial/calls.ts`'s and the import row's.
 */
async function undoingRefusal(context: RepositoryContext, work: () => Promise<FirmBasicsResult>): Promise<FirmBasicsResult> {
  let nested = true;
  try {
    await context.db.query(`SAVEPOINT ${BASICS_SAVEPOINT}`);
  } catch (error) {
    // 25P01 no_active_sql_transaction: not inside a transaction block.
    if ((error as { code?: string }).code !== '25P01') throw error;
    nested = false;
    await context.db.query('BEGIN');
  }
  const undo = async (): Promise<void> => {
    if (nested) {
      await context.db.query(`ROLLBACK TO SAVEPOINT ${BASICS_SAVEPOINT}`);
      await context.db.query(`RELEASE SAVEPOINT ${BASICS_SAVEPOINT}`);
    } else {
      await context.db.query('ROLLBACK');
    }
  };
  let result: FirmBasicsResult;
  try {
    result = await work();
  } catch (error) {
    await undo();
    throw error;
  }
  if (result.ok) await context.db.query(nested ? `RELEASE SAVEPOINT ${BASICS_SAVEPOINT}` : 'COMMIT');
  else await undo();
  return result;
}
