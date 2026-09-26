import type { CallingIdentityRefusalCode, CallingIdentityVerificationMethod } from '@fss/contracts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';

/**
 * Calling identities: how a salesperson's own number comes to exist, to be verified,
 * and to be retired (specification 9.1; lane g60).
 *
 * 9.1: "A calling identity is a verified outbound number; in version one it must be
 * active and owned by the acting salesperson", and "each salesperson can verify a
 * personal calling number". Migration 0001 made the table and `authorizeDial` has read
 * it at 9.2's second step since G4, but until this file nothing inserted a row or set
 * one to `verified`. Production's only salesperson could not place a call from Today,
 * and the restore drill's dial probe had no subject.
 *
 * ## Attested when added (wave 2, S4.3)
 *
 * Registering your own number is the attestation: `registerCallingIdentity` writes the
 * row verified and enabled, with who, how and when, in one insert — the fields
 * `calling_identities_verification_recorded` (0016) requires. There is no separate step
 * before a dial any more. `verifyCallingIdentity` stays because installed desktops up to
 * 1.0.11 still send `POST /calling-identities/attest`: for a number registered by an
 * older release, still unverified, it attests it as before; for any other it answers
 * `existing` and changes nothing.
 *
 * A number an older release registered and nobody attested is usable anyway: a dial asks
 * only that the number is the actor's own and usable (`USABLE_CALLING_IDENTITY_SQL`,
 * `authorizeDial` step 2), and `currentCallingIdentityId` offers it on the Today card. So
 * no stored row waits for an attestation it no longer needs.
 *
 * ## What "verified" means in version one
 *
 * There is no telephony provider in this stack: a call is a `tel:` handoff from the
 * Mac to whatever phone app the person has, and nothing FSS runs ever sees the line
 * the call leaves on. So there is nothing to measure, and the honest verification is
 * the person's own statement that this is the number they place calls from, recorded
 * with who made it and when — the same shape as 12.7's sending checklist, which is a
 * person saying they looked because FSS never queries DNS. An admin may make the
 * statement on a member's behalf, and that is recorded as a different method, because
 * it is different evidence. `docs/decisions/g60-calling-identities-are-attested-in-version-one.md`
 * has the reasoning and what a later call-back code would change.
 *
 * ## The rules, and where each is enforced
 *
 *   * **The number is E.164 and no country is assumed.** `+`, then 8 to 15 digits, the
 *     first not zero; spaces, dots, hyphens and parentheses after the `+` are
 *     formatting and are dropped. A number without the `+` is refused rather than
 *     read as North American: this is the person's own line, typed once, and a wrong
 *     guess would put their calls on somebody else's number.
 *     `calling_identities_e164_shape` is the same rule in the database.
 *   * **The owner is an active member.** Checked here with a reason; the foreign key
 *     to `workspace_memberships` is the structural half.
 *   * **Your own number is yours to manage; anybody else's is an admin's.** The actor
 *     comes from the scope, never from the caller, for the reason `openPause` takes
 *     its creator from the scope: a parameter would let a caller attest as somebody
 *     else.
 *   * **A null-owner row stays disabled.** 9.1 defers the shared line, nothing here
 *     can create one, and one written by hand is refused attestation
 *     (`identity_shared_line_disabled`, the word `authorizeDial` already uses).
 *     `calling_identities_shared_line_disabled` is the structural half.
 *   * **A verified row says who, how and when.** `calling_identities_verification_recorded`
 *     (migration 0016) refuses a `verified` row without them, so there is no second
 *     way to become verified — including an `INSERT`.
 *   * **A retirement keeps the row.** `call_logs` and `dial_tickets` reference it, and
 *     a history that pointed at nothing would be a history nobody can read.
 *
 * Every command returns its refusal as a value, never an exception, so the command
 * receipt can record it (`docs/greenfield/crm.md`, rule 2), and writes one audit event
 * in the caller's transaction. The audit detail carries identifiers and codes and
 * never the number: it is the salesperson's own personal data, and 5.2 keeps
 * unnecessary personal content out of audit records.
 */

export interface CallingIdentityRow {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly e164: string;
  readonly label: string | null;
  readonly verificationStatus: 'unverified' | 'verified';
  readonly enabled: boolean;
  readonly verifiedAt: string | null;
  readonly verifiedByUserId: string | null;
  readonly verificationMethod: CallingIdentityVerificationMethod | null;
  readonly disabledAt: string | null;
  readonly disabledByUserId: string | null;
  readonly createdAt: string;
  /**
   * Whether this is the number the owner's Today cards dial from: the one
   * `currentCallingIdentityId` chooses. Computed here so the Mac shows the server's
   * choice rather than re-deriving it.
   */
  readonly usedForCalls: boolean;
}

export type CallingIdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CallingIdentityRefusalCode };

export interface CallingIdentityChange<Outcome extends string> {
  readonly outcome: Outcome;
  readonly identity: CallingIdentityRow;
}

interface IdentityDbRow {
  readonly id: string;
  readonly owner_user_id: string | null;
  readonly e164: string;
  readonly label: string | null;
  readonly verification_status: 'unverified' | 'verified';
  readonly enabled: boolean;
  readonly verified_at: Date | null;
  readonly verified_by_user_id: string | null;
  readonly verification_method: CallingIdentityVerificationMethod | null;
  readonly disabled_at: Date | null;
  readonly disabled_by_user_id: string | null;
  readonly created_at: Date;
  readonly [column: string]: unknown;
}

const IDENTITY_COLUMNS = `id, owner_user_id, e164, label, verification_status, enabled, verified_at,
  verified_by_user_id, verification_method, disabled_at, disabled_by_user_id, created_at`;

/** The longest label a person may give a number. `calling_identities_label_shape` agrees. */
export const CALLING_IDENTITY_LABEL_MAX = 80;

const refuse = <T>(reason: CallingIdentityRefusalCode): CallingIdentityResult<T> => ({ ok: false, reason });
const accept = <T>(value: T): CallingIdentityResult<T> => ({ ok: true, value });

/**
 * A number as `calling_identities` stores it, or `number_invalid`.
 *
 * NFKC first, so a pasted non-breaking space or full-width digit becomes the ordinary
 * one; then the `+`, then only digits and the four formatting characters. The digit
 * rule is the table's CHECK, spelled the same way, so a refusal names the rule rather
 * than arriving as a constraint violation.
 */
export function normalizeCallingNumber(
  value: string,
): { readonly ok: true; readonly e164: string } | { readonly ok: false; readonly reason: 'number_invalid' } {
  const text = value.normalize('NFKC').trim();
  if (!text.startsWith('+')) return { ok: false, reason: 'number_invalid' };
  const rest = text.slice(1);
  if (!/^[0-9 ().-]+$/u.test(rest)) return { ok: false, reason: 'number_invalid' };
  const digits = rest.replaceAll(/[^0-9]/gu, '');
  if (!/^[1-9][0-9]{7,14}$/u.test(digits)) return { ok: false, reason: 'number_invalid' };
  return { ok: true, e164: `+${digits}` };
}

/** A label as stored: trimmed, null when empty, refused when too long or not plain text. */
function normalizeLabel(
  value: string | undefined,
): { readonly ok: true; readonly label: string | null } | { readonly ok: false } {
  if (value === undefined) return { ok: true, label: null };
  const label = value.normalize('NFKC').trim();
  if (label.length === 0) return { ok: true, label: null };
  if (label.length > CALLING_IDENTITY_LABEL_MAX || /\p{Cc}/u.test(label)) return { ok: false };
  return { ok: true, label };
}

/**
 * Whether a calling identity may be dialled from, as SQL over `calling_identities`
 * (wave 2, S4.3): not retired, and not a verified number somebody switched off. An
 * unverified row — registered by an older release, never attested — has no switch to be
 * off and is usable. Verification itself is not asked: a number is attested when added.
 */
export const USABLE_CALLING_IDENTITY_SQL =
  "(disabled_at IS NULL AND (enabled OR verification_status = 'unverified'))";

/**
 * The number an owner's Today cards dial from, or null (9.1: "active and owned by the
 * acting salesperson").
 *
 * The most recently added or attested of their numbers that are not retired. Adding a
 * number says "this is the number I place calls from", so the latest one is the current
 * answer: a person who adds a new number has said which line they are on now, without
 * having to retire the old one first. `readTodayFirm` asks this and so does the list
 * below, so the card and the settings page cannot disagree about which number is in use.
 */
export async function currentCallingIdentityId(
  context: RepositoryContext,
  ownerUserId: string,
): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM calling_identities
      WHERE workspace_id = $1 AND owner_user_id = $2 AND ${USABLE_CALLING_IDENTITY_SQL}
      ORDER BY coalesce(verified_at, created_at) DESC, created_at DESC, id
      LIMIT 1`,
    [context.scope.workspaceId, ownerUserId],
  );
  return rows[0]?.id ?? null;
}

function mapRow(row: IdentityDbRow, currentId: string | null): CallingIdentityRow {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    e164: row.e164,
    label: row.label,
    verificationStatus: row.verification_status,
    enabled: row.enabled,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    verifiedByUserId: row.verified_by_user_id,
    verificationMethod: row.verification_method,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    disabledByUserId: row.disabled_by_user_id,
    createdAt: row.created_at.toISOString(),
    usedForCalls: currentId === row.id,
  };
}

async function toRow(context: RepositoryContext, row: IdentityDbRow): Promise<CallingIdentityRow> {
  const current = row.owner_user_id === null ? null : await currentCallingIdentityId(context, row.owner_user_id);
  return mapRow(row, current);
}

async function isActiveMember(context: RepositoryContext, userId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ present: boolean }>(
    `SELECT true AS present FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [context.scope.workspaceId, userId],
  );
  return rows[0]?.present === true;
}

async function lockIdentity(context: RepositoryContext, identityId: string): Promise<IdentityDbRow | null> {
  const { rows } = await context.db.query<IdentityDbRow>(
    `SELECT ${IDENTITY_COLUMNS} FROM calling_identities WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, identityId],
  );
  return rows[0] ?? null;
}

/** The acting user's own numbers, oldest first. A system scope owns none. */
export async function listOwnCallingIdentities(context: RepositoryContext): Promise<readonly CallingIdentityRow[]> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return [];
  const { rows } = await context.db.query<IdentityDbRow>(
    `SELECT ${IDENTITY_COLUMNS} FROM calling_identities
      WHERE workspace_id = $1 AND owner_user_id = $2
      ORDER BY created_at, id`,
    [context.scope.workspaceId, actor.userId],
  );
  const current = await currentCallingIdentityId(context, actor.userId);
  return rows.map(row => mapRow(row, current));
}

export interface RegisterCallingIdentityInput {
  /** Absent for "my own number". Naming another member is an admin's act. */
  readonly ownerUserId?: string | undefined;
  /** As typed. Normalized by `normalizeCallingNumber`. */
  readonly e164: string;
  readonly label?: string | undefined;
}

/**
 * How many times a registration re-reads after an insert that inserted nothing.
 *
 * `ON CONFLICT DO NOTHING` answers a concurrent registration of the same number with an
 * empty result; the next read returns the row that won. One race costs one pass.
 */
const REGISTRATION_PASSES = 2;

/**
 * Register a number, attested: verified and enabled, with who, how and when (wave 2,
 * S4.3). The method is decided by who acts, as `verifyCallingIdentity` decides it: the
 * owner's own registration is `owner_attestation`, an admin's on a member's behalf
 * `admin_attestation`.
 *
 * Idempotent on the workspace and the number, which is the table's own unique key: a
 * second registration by the same owner returns the row — attested now if an older
 * release left it unverified or it had been retired, and otherwise exactly as it is,
 * so a retry never moves `verified_at` — and a registration of a number somebody else
 * already holds is refused rather than moved. Ownership never changes here.
 */
export async function registerCallingIdentity(
  context: RepositoryContext,
  input: RegisterCallingIdentityInput,
): Promise<CallingIdentityResult<CallingIdentityChange<'created' | 'existing' | 'verified'>>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('admin_only');
  const ownerUserId = input.ownerUserId ?? actor.userId;
  if (ownerUserId !== actor.userId && !isAdminScope(context.scope)) return refuse('admin_only');
  const method: CallingIdentityVerificationMethod =
    ownerUserId === actor.userId ? 'owner_attestation' : 'admin_attestation';

  const number = normalizeCallingNumber(input.e164);
  if (!number.ok) return refuse('number_invalid');
  const label = normalizeLabel(input.label);
  if (!label.ok) return refuse('label_invalid');
  if (!(await isActiveMember(context, ownerUserId))) return refuse('owner_not_member');

  for (let pass = 0; pass < REGISTRATION_PASSES; pass += 1) {
    const existing = await context.db.query<IdentityDbRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM calling_identities WHERE workspace_id = $1 AND e164 = $2`,
      [context.scope.workspaceId, number.e164],
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      if (found.owner_user_id !== ownerUserId) return refuse('number_registered_to_another');
      if (found.verification_status === 'verified' && found.enabled) {
        return accept({ outcome: 'existing', identity: await toRow(context, found) });
      }
      const locked = await lockIdentity(context, found.id);
      if (locked === null) continue;
      return accept({ outcome: 'verified', identity: await toRow(context, await attest(context, locked, method)) });
    }

    // Attested in the insert (wave 2, S4.3): adding your number is the statement that it
    // is the line you call from, recorded with who, how and when as 0016 requires.
    const inserted = await context.db.query<IdentityDbRow>(
      `INSERT INTO calling_identities
         (workspace_id, owner_user_id, e164, label, verification_status, enabled,
          verified_at, verified_by_user_id, verification_method)
       VALUES ($1, $2, $3, $4, 'verified', true, now(), $5, $6)
       ON CONFLICT (workspace_id, e164) DO NOTHING
       RETURNING ${IDENTITY_COLUMNS}`,
      [context.scope.workspaceId, ownerUserId, number.e164, label.label, actor.userId, method],
    );
    const row = inserted.rows[0];
    if (row === undefined) continue;

    await recordCrmAuditEvent(context, {
      action: 'calling_identity.registered',
      subjectKind: 'calling_identity',
      subjectId: row.id,
      detail: { ownerUserId, onBehalf: ownerUserId !== actor.userId, method },
    });
    return accept({ outcome: 'created', identity: await toRow(context, row) });
  }
  throw new Error(`the registration of a calling identity did not settle in ${String(REGISTRATION_PASSES)} passes`);
}

/**
 * Verify and enable a locked row, recording who, how and when, and audit it. The one
 * statement both registration and the attest command write.
 */
async function attest(
  context: RepositoryContext,
  row: IdentityDbRow,
  method: CallingIdentityVerificationMethod,
): Promise<IdentityDbRow> {
  const actor = context.scope.actor;
  const { rows } = await context.db.query<IdentityDbRow>(
    `UPDATE calling_identities
        SET verification_status = 'verified',
            enabled = true,
            verified_at = now(),
            verified_by_user_id = $3,
            verification_method = $4,
            disabled_at = NULL,
            disabled_by_user_id = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${IDENTITY_COLUMNS}`,
    [context.scope.workspaceId, row.id, actor.kind === 'user' ? actor.userId : null, method],
  );
  const updated = rows[0];
  if (updated === undefined) throw new Error(`the calling identity ${row.id} vanished under its own row lock`);
  await recordCrmAuditEvent(context, {
    action: 'calling_identity.attested',
    subjectKind: 'calling_identity',
    subjectId: updated.id,
    detail: { ownerUserId: row.owner_user_id, method, reenabled: row.disabled_at !== null },
  });
  return updated;
}

/**
 * Attest a number: "this is the number I place calls from" (9.1's verification, in
 * version one). Verifies and enables it, recording who, how and when.
 *
 * @deprecated (remove after desktop 1.0.12) — a number is attested when it is registered
 * (wave 2, S4.3), and an unattested one is usable anyway. Kept because installed
 * desktops up to 1.0.11 still send `POST /calling-identities/attest`; for a number that
 * is already verified and enabled it is a no-op answering `existing`.
 *
 * The method is decided by who acts, not asked for: the owner's own statement is
 * `owner_attestation`; an admin's on a member's behalf is `admin_attestation`; anybody
 * else is answered `identity_unknown`. The owner must still be an active member — a
 * departed salesperson's number is not made dialable by an admin's statement about it.
 *
 * Idempotent: a number that is already verified and enabled is returned unchanged, so
 * a retried command does not move `verified_at`. A retired number may be attested
 * again, which re-enables it; the retirement stays in the audit trail.
 */
export async function verifyCallingIdentity(
  context: RepositoryContext,
  input: { readonly identityId: string },
): Promise<CallingIdentityResult<CallingIdentityChange<'verified' | 'existing'>>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('admin_only');

  const row = await lockIdentity(context, input.identityId);
  if (row === null) return refuse('identity_unknown');
  const owner = row.owner_user_id;
  if (owner === null) {
    return isAdminScope(context.scope) ? refuse('identity_shared_line_disabled') : refuse('identity_unknown');
  }
  const method: CallingIdentityVerificationMethod | null =
    owner === actor.userId ? 'owner_attestation' : isAdminScope(context.scope) ? 'admin_attestation' : null;
  // A colleague's number is `identity_unknown` to a salesperson rather than "not
  // yours": the difference would tell them the number is registered to somebody.
  if (method === null) return refuse('identity_unknown');
  if (!(await isActiveMember(context, owner))) return refuse('owner_not_member');

  if (row.verification_status === 'verified' && row.enabled) {
    return accept({ outcome: 'existing', identity: await toRow(context, row) });
  }
  return accept({ outcome: 'verified', identity: await toRow(context, await attest(context, row, method)) });
}

/**
 * Retire a number: disabled, with who and when, and never deleted.
 *
 * `call_logs.calling_identity_id` and `dial_tickets.calling_identity_id` reference the
 * row, so a delete would either fail or orphan the history that says which line a
 * call left on. `authorizeDial` refuses a retired number `identity_disabled`, and the
 * Today card stops offering it at once, because both read `enabled`. The verification
 * columns are left as they were: they are the record of an attestation that was true
 * when it was made. Idempotent on a number already retired.
 */
export async function disableCallingIdentity(
  context: RepositoryContext,
  input: { readonly identityId: string },
): Promise<CallingIdentityResult<CallingIdentityChange<'disabled' | 'existing'>>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('admin_only');

  const row = await lockIdentity(context, input.identityId);
  if (row === null) return refuse('identity_unknown');
  const mayRetire = row.owner_user_id === actor.userId || isAdminScope(context.scope);
  if (!mayRetire) return refuse('identity_unknown');

  if (row.disabled_at !== null) return accept({ outcome: 'existing', identity: await toRow(context, row) });

  const { rows } = await context.db.query<IdentityDbRow>(
    `UPDATE calling_identities
        SET enabled = false,
            disabled_at = now(),
            disabled_by_user_id = $3,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${IDENTITY_COLUMNS}`,
    [context.scope.workspaceId, row.id, actor.userId],
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('identity_unknown');

  await recordCrmAuditEvent(context, {
    action: 'calling_identity.disabled',
    subjectKind: 'calling_identity',
    subjectId: updated.id,
    detail: { ownerUserId: row.owner_user_id, wasEnabled: row.enabled },
  });
  return accept({ outcome: 'disabled', identity: await toRow(context, updated) });
}
