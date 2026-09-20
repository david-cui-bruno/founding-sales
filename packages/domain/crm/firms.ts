import type { RepositoryContext } from '../db/workspaceScope.ts';
import { resolveFirmZone } from '../src/rules/statePosture.ts';
import { decideAdminOnly, decideFirmMutation } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { emitCrmDomainEvent } from './events.ts';
import { FIRM_ZONE_SOURCES } from './zone.ts';
import {
  accept,
  refuse,
  type CrmResult,
  type FirmRow,
} from './types.ts';

/**
 * Firms: create, update, reassign, and the zone resolution behind them
 * (specification 7.2, 9.2, Appendix A "Reassign firm", Appendix G 7).
 *
 * Every mutation here follows the same three steps, in this order and no other:
 *
 *   1. load the firm `FOR UPDATE`;
 *   2. ask `decideFirmMutation`;
 *   3. write.
 *
 * The lock before the decision is the whole of Appendix G 7's "including concurrent
 * reassignment". A command that read the assignee outside a lock could be overtaken
 * by a reassignment between the read and the write, and the former owner would get
 * one more mutation in. With the lock, the former owner's command waits, then reads
 * the assignee the reassignment left, and is refused.
 */

const FIRM_COLUMNS = `id, workspace_id, name, assigned_user_id, website, address_line, locality, region_code,
  postal_code, country_code, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version,
  time_zone_unresolved_reason, status, merged_into_firm_id, created_at, updated_at`;

/**
 * One firm, locked for the rest of the transaction, or null.
 *
 * There is no unlocked variant for a mutation to reach for. Reads use
 * `readFirm`, which does not lock and does not let a caller write.
 */
export async function loadFirmForUpdate(
  context: RepositoryContext,
  firmId: string,
): Promise<FirmRow | null> {
  const { rows } = await context.db.query<FirmRow>(
    `SELECT ${FIRM_COLUMNS} FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, firmId],
  );
  return rows[0] ?? null;
}

/** One firm, not locked. For reads only. */
export async function readFirm(context: RepositoryContext, firmId: string): Promise<FirmRow | null> {
  const { rows } = await context.db.query<FirmRow>(
    `SELECT ${FIRM_COLUMNS} FROM firms WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, firmId],
  );
  return rows[0] ?? null;
}

export interface CreateFirmInput {
  readonly name: string;
  readonly website?: string | undefined;
  readonly addressLine?: string | undefined;
  readonly locality?: string | undefined;
  readonly regionCode?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly countryCode?: string | undefined;
  /** Omitted leaves the firm unassigned, which is where a discovered firm starts. */
  readonly assignedUserId?: string | undefined;
  /** Carried from an import or an old system; preserved through merges as an alias. */
  readonly externalId?: string | undefined;
  readonly commandId?: string | undefined;
}

/**
 * Create a firm.
 *
 * A salesperson may only create a firm assigned to themselves or to nobody: the
 * alternative is a way to put work on a colleague's list without an assignment
 * command, and Appendix G 7 would have a hole in it.
 */
export async function createFirm(
  context: RepositoryContext,
  input: CreateFirmInput,
): Promise<CrmResult<FirmRow>> {
  const actor = context.scope.actor;
  if (
    actor.kind === 'user' &&
    actor.role !== 'admin' &&
    input.assignedUserId !== undefined &&
    input.assignedUserId !== actor.userId
  ) {
    return refuse('not_assigned');
  }
  if (input.name.trim().length === 0) return refuse('invalid_input');

  let created: FirmRow;
  try {
    const { rows } = await context.db.query<FirmRow>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, website, address_line, locality,
                          region_code, postal_code, country_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'US'))
       RETURNING ${FIRM_COLUMNS}`,
      [
        context.scope.workspaceId,
        input.name.trim(),
        input.assignedUserId ?? null,
        input.website ?? null,
        input.addressLine ?? null,
        input.locality ?? null,
        input.regionCode ?? null,
        input.postalCode ?? null,
        input.countryCode ?? null,
      ],
    );
    const row = rows[0];
    if (row === undefined) return refuse('invalid_input');
    created = row;
  } catch (error) {
    // A named assignee who is not a member of this workspace is refused by
    // `firms_assignee_fkey`, and that is a refusal rather than a crash.
    if (isForeignKeyViolation(error, 'firms_assignee_fkey')) return refuse('assignee_unknown');
    throw error;
  }

  if (input.externalId !== undefined && input.externalId.trim().length > 0) {
    await context.db.query(
      `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
       VALUES ($1, 'firm', $2, 'external_id', $3)
       ON CONFLICT ON CONSTRAINT record_aliases_unique DO NOTHING`,
      [context.scope.workspaceId, created.id, input.externalId.trim()],
    );
  }

  await recordCrmAuditEvent(context, {
    action: 'firm.created',
    subjectKind: 'firm',
    subjectId: created.id,
    detail: { assigned: created.assigned_user_id !== null },
  });
  return accept(created);
}

export interface FirmPatch {
  readonly name?: string | undefined;
  readonly website?: string | null | undefined;
  readonly addressLine?: string | null | undefined;
  readonly locality?: string | null | undefined;
  readonly regionCode?: string | null | undefined;
  readonly postalCode?: string | null | undefined;
  readonly countryCode?: string | undefined;
}

const PATCH_COLUMNS: Readonly<Record<keyof FirmPatch, string>> = Object.freeze({
  name: 'name',
  website: 'website',
  addressLine: 'address_line',
  locality: 'locality',
  regionCode: 'region_code',
  postalCode: 'postal_code',
  countryCode: 'country_code',
});

/**
 * Update a firm's canonical fields. The assignee is deliberately not patchable: it
 * changes through `reassignFirm`, which also creates the hold, the transfer signal
 * and the audit event Appendix A requires.
 */
export async function updateFirm(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly patch: FirmPatch },
): Promise<CrmResult<FirmRow>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  const assignments: string[] = [];
  const values: unknown[] = [context.scope.workspaceId, input.firmId];
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    const value = input.patch[field as keyof FirmPatch];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}`);
  }
  if (assignments.length === 0) return accept(firm);

  const { rows } = await context.db.query<FirmRow>(
    `UPDATE firms SET ${assignments.join(', ')}, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${FIRM_COLUMNS}`,
    values,
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('firm_unknown');

  await recordCrmAuditEvent(context, {
    action: 'firm.updated',
    subjectKind: 'firm',
    subjectId: input.firmId,
    detail: { fields: Object.keys(input.patch).sort() },
  });
  return accept(updated);
}

export interface ReassignFirmInput {
  readonly firmId: string;
  readonly toUserId: string;
  readonly reason?: string | undefined;
  readonly commandId?: string | undefined;
}

export interface ReassignFirmOutcome {
  readonly firmId: string;
  readonly fromUserId: string | null;
  readonly toUserId: string;
  /** The `active_holds` row that blocks automated work while the handover settles. */
  readonly holdId: string;
}

/**
 * Reassign a firm (Appendix A, row "Reassign firm").
 *
 * | Locks / uniqueness | Commits together | After commit |
 * |---|---|---|
 * | Firm, open opportunity, holds, enrollments, fences, Today entries | Assignee change, reassignment hold, future-work cancellation/rebind, Today transfer, audit | Dispatching mail remains with former mailbox and reconciles there |
 *
 * This lane owns the first two columns of the middle cell and the audit event, and
 * signals the rest: enrollments, fences and Today entries do not exist yet, so the
 * cancellation and the transfer are a `firm.reassigned` domain event the lanes that
 * own them subscribe to. The hold is real now, and it is what stops automated work
 * from running between the assignee change and those lanes catching up — which is
 * the point of the hold rather than a placeholder for it.
 *
 * Only an admin reassigns. A salesperson handing their own firm to a colleague is
 * still a change to who may contact a prospect, and section 5.2 gives assignment to
 * admins.
 */
export async function reassignFirm(
  context: RepositoryContext,
  input: ReassignFirmInput,
): Promise<CrmResult<ReassignFirmOutcome>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  if (firm.status === 'merged') return refuse('firm_merged');

  // A salesperson is refused for the same reason and with the same code as every
  // other mutation on a firm that is not theirs; an assigned salesperson asking to
  // reassign is refused as admin-only.
  const mutation = decideFirmMutation(context, firm);
  if (!mutation.permitted) return refuse(mutation.reason);
  const admin = decideAdminOnly(context);
  if (!admin.permitted) return refuse(admin.reason);

  const fromUserId = firm.assigned_user_id;
  if (fromUserId === input.toUserId) return accept({ firmId: firm.id, fromUserId, toUserId: input.toUserId, holdId: '' });

  try {
    await context.db.query(
      'UPDATE firms SET assigned_user_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, input.firmId, input.toUserId],
    );
  } catch (error) {
    if (isForeignKeyViolation(error, 'firms_assignee_fkey')) return refuse('assignee_unknown');
    throw error;
  }

  // Section 4.3 and 15: a hold names its scope, its reason, the action kinds it
  // blocks, its source event and the recovery that clears it. Nothing else clears it.
  const hold = await context.db.query<{ id: string }>(
    `INSERT INTO active_holds
       (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind,
        source_event_id, owner_user_id, recovery_action)
     VALUES ($1, 'firm', $2, 'reassignment',
             ARRAY['email_send', 'call_task', 'linkedin_task', 'dial_authorization', 'enrollment_advance']::text[],
             'firm.reassigned', $3, $4, 'resume_after_review')
     RETURNING id`,
    [context.scope.workspaceId, input.firmId, input.commandId ?? null, input.toUserId],
  );
  const holdId = hold.rows[0]?.id ?? '';

  await emitCrmDomainEvent(context, {
    kind: 'firm.reassigned',
    firmId: input.firmId,
    dedupeKey: `${input.firmId}:${holdId}`,
    reasonCode: 'reassignment',
    commandId: input.commandId,
    detail: { fromUserId, toUserId: input.toUserId, holdId },
  });

  await recordCrmAuditEvent(context, {
    action: 'firm.reassigned',
    subjectKind: 'firm',
    subjectId: input.firmId,
    detail: { fromUserId, toUserId: input.toUserId, reason: input.reason ?? null },
  });

  return accept({ firmId: input.firmId, fromUserId, toUserId: input.toUserId, holdId });
}

export interface FirmZoneOutcome {
  readonly firmId: string;
  readonly timeZone: string;
  readonly confidence: 'high' | 'medium';
  readonly source: string;
  readonly ruleVersion: string;
}

/**
 * Establish the firm's actual IANA zone and record how (specification 9.2).
 *
 * "The firm's zone is resolved from location or postal data under a versioned source
 * rule; inability to establish it blocks calling." Both outcomes are written: a
 * resolved zone with its confidence, source and rule version, or a null zone with the
 * reason it could not be established. `authorizeDial` (G4) reads the same columns for
 * both, and refuses on the second — so "blocks calling" is a recorded fact rather
 * than the absence of one.
 */
export async function resolveZoneForFirm(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly recordedZone?: string | undefined },
): Promise<CrmResult<FirmZoneOutcome>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  const resolution = resolveFirmZone(
    {
      recordedZone: input.recordedZone,
      state: firm.region_code ?? undefined,
      postalCode: firm.postal_code ?? undefined,
    },
    FIRM_ZONE_SOURCES,
  );

  if (resolution.kind === 'resolved') {
    await context.db.query(
      `UPDATE firms
          SET time_zone = $3, time_zone_confidence = $4, time_zone_source = $5,
              time_zone_rule_version = $6, time_zone_unresolved_reason = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [
        context.scope.workspaceId,
        input.firmId,
        resolution.zone,
        resolution.confidence,
        resolution.source,
        resolution.ruleVersion,
      ],
    );
    return accept({
      firmId: input.firmId,
      timeZone: resolution.zone,
      confidence: resolution.confidence,
      source: resolution.source,
      ruleVersion: resolution.ruleVersion,
    });
  }

  await context.db.query(
    `UPDATE firms
        SET time_zone = NULL, time_zone_confidence = NULL, time_zone_source = NULL,
            time_zone_rule_version = $3, time_zone_unresolved_reason = $4, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.firmId, resolution.ruleVersion, resolution.reason],
  );
  return refuse('zone_unresolved');
}

const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';

export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const detail = error as { code?: string; constraint?: string };
  return detail.code === POSTGRES_FOREIGN_KEY_VIOLATION && detail.constraint === constraint;
}
