import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { accept, refuse, type RetentionResult } from './result.ts';

/**
 * Departure (specification 10.3, Appendix F, 5.2, 5.3).
 *
 * > Departure immediately revokes membership, devices, sessions, and OAuth grants and
 * > deletes refresh-token material. Firm-related business correspondence remains;
 * > private drafts, raw mailbox material, and unrelated metadata expire under the
 * > table above.
 *
 * One command, and it is the *complete* version of the partial one
 * `POST /admin/memberships/deactivate` already performs. That endpoint revokes the
 * membership, the devices, the sessions and the device credentials, which is four of
 * the six things this sentence asks for; it does not touch the Gmail grant, does not
 * delete the refresh token, and does nothing about the firms the departing member
 * was the only person working. This command does all six and records what it did.
 *
 * ## What it deletes, and what it emphatically does not
 *
 * The one row this command deletes is `mailbox_tokens`. Migration 0009 gave the
 * envelope-encrypted refresh token its own table for exactly this: "10.3's
 * 'departure ... deletes refresh-token material' is then one DELETE that leaves every
 * business fact about the mailbox in place".
 *
 * The mailbox row itself is disconnected, never deleted. Every message the firm ever
 * exchanged hangs off it by foreign key, and 10.3 says that correspondence remains.
 * A departure that deleted the mailbox would delete the firm's history as a side
 * effect of a person leaving, which is the exact opposite of the sentence.
 *
 * ## The firms
 *
 * The brief asks departure to "hold the departed user's enrollments for
 * reassignment". `enrollments` is lane G8's table and is not on main, so what this
 * command holds is the thing enrollments hang off and the thing an eligibility check
 * already reads: a `reassignment` hold per firm the departed member owns, blocking
 * every automated action kind including `enrollment_advance`. When G8 lands, its
 * pre-action re-read finds that hold and stops, without G8 having to know a departure
 * happened — which is why the hold is the right place for it rather than a column on
 * a table that does not exist yet. `PENDING_RETENTION_TABLES` names the follow-up.
 *
 * The assignment itself is left alone. Section 5.2 gives assignment to admins, and an
 * admin cannot reassign a firm they cannot see the owner of; nulling the assignee
 * would hide the work that needs a new owner at the moment somebody has to find it.
 */

export type DepartureRefusal =
  | 'admin_only'
  | 'self_departure'
  | 'membership_unknown'
  | 'last_active_admin';

export interface DeparturePreview {
  readonly userId: string;
  readonly role: 'admin' | 'salesperson';
  readonly activeDevices: number;
  readonly activeSessions: number;
  readonly activeRefreshCredentials: number;
  readonly connectedMailboxes: number;
  /** Rows of envelope-encrypted refresh-token material this departure would delete. */
  readonly refreshTokenRows: number;
  readonly assignedFirms: number;
  /** True when the departure has already happened; a commit would report it, not redo it. */
  readonly alreadyDeparted: boolean;
}

export interface DepartureOutcome {
  readonly userId: string;
  readonly membershipRevoked: boolean;
  readonly devicesRevoked: number;
  readonly sessionsEnded: number;
  readonly refreshCredentialsRevoked: number;
  readonly mailboxesDisconnected: number;
  readonly watchesCancelled: number;
  readonly refreshTokenMaterialDeleted: boolean;
  readonly firmsHeldForReassignment: number;
  /** True when this call found the departure already recorded. Nothing was revoked. */
  readonly replayed: boolean;
}

const HELD_ACTION_KINDS = [
  'email_send',
  'call_task',
  'linkedin_task',
  'dial_authorization',
  'enrollment_advance',
  'research',
] as const;

async function countOf(context: RepositoryContext, sql: string, values: readonly unknown[]): Promise<number> {
  const { rows } = await context.db.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
}

interface MembershipRow {
  readonly role: 'admin' | 'salesperson';
  readonly status: 'active' | 'inactive';
  readonly [column: string]: unknown;
}

/**
 * Would departing this member leave the workspace with no active admin?
 *
 * `FOR UPDATE` over the admin rows, the same lock `POST /admin/memberships/role`
 * takes, so two concurrent "depart the other admin" commands serialize and the
 * second one sees the count the first left behind. Section 5.2: "The last active
 * admin cannot deactivate themselves or be removed."
 */
async function wouldStrandTheWorkspace(context: RepositoryContext, userId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ user_id: string }>(
    `SELECT user_id FROM workspace_memberships
      WHERE workspace_id = $1 AND role = 'admin' AND status = 'active'
      FOR UPDATE`,
    [context.scope.workspaceId],
  );
  return rows.length <= 1 && rows.some(row => row.user_id === userId);
}

async function loadMembership(context: RepositoryContext, userId: string): Promise<MembershipRow | null> {
  const { rows } = await context.db.query<MembershipRow>(
    'SELECT role, status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
    [context.scope.workspaceId, userId],
  );
  return rows[0] ?? null;
}

export async function previewDeparture(
  context: RepositoryContext,
  input: { readonly userId: string },
): Promise<RetentionResult<DeparturePreview, DepartureRefusal>> {
  if (!isAdminScope(context.scope)) return refuse('admin_only');
  const membership = await loadMembership(context, input.userId);
  if (membership === null) return refuse('membership_unknown');

  const workspace = context.scope.workspaceId;
  const preview: DeparturePreview = {
    userId: input.userId,
    role: membership.role,
    activeDevices: await countOf(
      context,
      "SELECT count(*) AS count FROM devices WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
      [workspace, input.userId],
    ),
    activeSessions: await countOf(
      context,
      "SELECT count(*) AS count FROM sessions WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
      [workspace, input.userId],
    ),
    activeRefreshCredentials: await countOf(
      context,
      `SELECT count(*) AS count FROM device_refresh_credentials c
         JOIN devices d ON d.workspace_id = c.workspace_id AND d.id = c.device_id
        WHERE c.workspace_id = $1 AND d.user_id = $2 AND c.state = 'active'`,
      [workspace, input.userId],
    ),
    connectedMailboxes: await countOf(
      context,
      "SELECT count(*) AS count FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2 AND status = 'connected'",
      [workspace, input.userId],
    ),
    refreshTokenRows: await countOf(
      context,
      `SELECT count(*) AS count FROM mailbox_tokens t
         JOIN mailboxes m ON m.workspace_id = t.workspace_id AND m.id = t.mailbox_id
        WHERE t.workspace_id = $1 AND m.owner_user_id = $2`,
      [workspace, input.userId],
    ),
    assignedFirms: await countOf(
      context,
      "SELECT count(*) AS count FROM firms WHERE workspace_id = $1 AND assigned_user_id = $2 AND status = 'active'",
      [workspace, input.userId],
    ),
    alreadyDeparted:
      (await countOf(context, 'SELECT count(*) AS count FROM departures WHERE workspace_id = $1 AND user_id = $2', [
        workspace,
        input.userId,
      ])) > 0,
  };
  return accept(preview);
}

export interface CommitDepartureInput {
  readonly userId: string;
  readonly commandId?: string | undefined;
}

export async function commitDeparture(
  context: RepositoryContext,
  input: CommitDepartureInput,
): Promise<RetentionResult<DepartureOutcome, DepartureRefusal>> {
  if (!isAdminScope(context.scope)) return refuse('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('admin_only');
  if (actor.userId === input.userId) return refuse('self_departure');

  const workspace = context.scope.workspaceId;
  const membership = await loadMembership(context, input.userId);
  if (membership === null) return refuse('membership_unknown');
  if (await wouldStrandTheWorkspace(context, input.userId)) return refuse('last_active_admin');

  // `departures_one_per_user` is the replay guard. Claiming it first means a second
  // command cannot begin revoking anything, rather than revoking it a second time and
  // discovering afterwards that it had already happened.
  const claim = await context.db.query<{ id: string }>(
    `INSERT INTO departures (workspace_id, user_id, requested_by_user_id, command_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT departures_one_per_user DO NOTHING
     RETURNING id`,
    [workspace, input.userId, actor.userId, input.commandId ?? null],
  );
  const departureId = claim.rows[0]?.id;
  if (departureId === undefined) {
    const { rows } = await context.db.query<{ outcome: Partial<DepartureOutcome> }>(
      'SELECT outcome FROM departures WHERE workspace_id = $1 AND user_id = $2',
      [workspace, input.userId],
    );
    const recorded = rows[0]?.outcome ?? {};
    return accept({
      userId: input.userId,
      membershipRevoked: recorded.membershipRevoked ?? true,
      devicesRevoked: recorded.devicesRevoked ?? 0,
      sessionsEnded: recorded.sessionsEnded ?? 0,
      refreshCredentialsRevoked: recorded.refreshCredentialsRevoked ?? 0,
      mailboxesDisconnected: recorded.mailboxesDisconnected ?? 0,
      watchesCancelled: recorded.watchesCancelled ?? 0,
      refreshTokenMaterialDeleted: recorded.refreshTokenMaterialDeleted ?? false,
      firmsHeldForReassignment: recorded.firmsHeldForReassignment ?? 0,
      replayed: true,
    });
  }

  const membershipUpdate = await context.db.query(
    `UPDATE workspace_memberships
        SET status = 'inactive', deactivated_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [workspace, input.userId],
  );
  const devices = await context.db.query(
    `UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [workspace, input.userId],
  );
  const sessions = await context.db.query(
    `UPDATE sessions SET status = 'ended', ended_at = now(), end_reason = 'membership_revoked'
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [workspace, input.userId],
  );
  const credentials = await context.db.query(
    `UPDATE device_refresh_credentials c SET state = 'revoked'
       FROM devices d
      WHERE d.workspace_id = c.workspace_id AND d.id = c.device_id
        AND c.workspace_id = $1 AND d.user_id = $2 AND c.state = 'active'`,
    [workspace, input.userId],
  );

  // The Gmail grant. The watch is cancelled first, because a live watch for a
  // disconnected mailbox would keep pushing notifications the webhook then rejects.
  const watches = await context.db.query(
    `UPDATE mailbox_watches w
        SET cancelled_at = now(), cancelled_reason = 'owner departed'
       FROM mailboxes m
      WHERE m.workspace_id = w.workspace_id AND m.id = w.mailbox_id
        AND w.workspace_id = $1 AND m.owner_user_id = $2 AND w.cancelled_at IS NULL`,
    [workspace, input.userId],
  );
  const mailboxes = await context.db.query(
    `UPDATE mailboxes
        SET status = 'revoked', disconnected_at = now(), disconnect_reason = 'owner departed', updated_at = now()
      WHERE workspace_id = $1 AND owner_user_id = $2 AND status = 'connected'`,
    [workspace, input.userId],
  );
  // The one deletion: the envelope-encrypted refresh token, as one row per mailbox.
  const tokens = await context.db.query(
    `DELETE FROM mailbox_tokens t
      USING mailboxes m
      WHERE m.workspace_id = t.workspace_id AND m.id = t.mailbox_id
        AND t.workspace_id = $1 AND m.owner_user_id = $2`,
    [workspace, input.userId],
  );

  // One reassignment hold per firm the departed member still owns.
  const holds = await context.db.query<{ id: string }>(
    `INSERT INTO active_holds
       (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind,
        source_event_id, owner_user_id, recovery_action)
     SELECT $1, 'firm', f.id::text, 'reassignment', $3::text[], 'membership.departed', $4, $2, 'resume_after_review'
       FROM firms f
      WHERE f.workspace_id = $1 AND f.assigned_user_id = $2 AND f.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM active_holds h
           WHERE h.workspace_id = f.workspace_id AND h.scope_kind = 'firm' AND h.scope_key = f.id::text
             AND h.reason_code = 'reassignment' AND h.source_event_kind = 'membership.departed'
             AND h.released_at IS NULL
        )
     RETURNING id`,
    [workspace, input.userId, [...HELD_ACTION_KINDS], departureId],
  );

  const outcome: DepartureOutcome = {
    userId: input.userId,
    membershipRevoked: (membershipUpdate.rowCount ?? 0) > 0,
    devicesRevoked: devices.rowCount ?? 0,
    sessionsEnded: sessions.rowCount ?? 0,
    refreshCredentialsRevoked: credentials.rowCount ?? 0,
    mailboxesDisconnected: mailboxes.rowCount ?? 0,
    watchesCancelled: watches.rowCount ?? 0,
    refreshTokenMaterialDeleted: (tokens.rowCount ?? 0) > 0,
    firmsHeldForReassignment: holds.rows.length,
    replayed: false,
  };

  await context.db.query(
    `UPDATE departures SET refresh_token_material_deleted = $3, outcome = $4::jsonb
      WHERE workspace_id = $1 AND id = $2`,
    [workspace, departureId, outcome.refreshTokenMaterialDeleted, JSON.stringify(outcome)],
  );

  await recordCrmAuditEvent(context, {
    action: 'departure.committed',
    subjectKind: 'user',
    subjectId: input.userId,
    detail: {
      departureId,
      devicesRevoked: outcome.devicesRevoked,
      sessionsEnded: outcome.sessionsEnded,
      mailboxesDisconnected: outcome.mailboxesDisconnected,
      refreshTokenMaterialDeleted: outcome.refreshTokenMaterialDeleted,
      firmsHeldForReassignment: outcome.firmsHeldForReassignment,
    },
  });

  return accept(outcome);
}
