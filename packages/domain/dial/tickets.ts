import type { DialRefusalCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { databaseNow } from '../policy/clock.ts';
import { authorizeDial, type AuthorizeDialInput, type DialEvidence } from './authorize.ts';

/**
 * One-use dial tickets (specification 9.2, 5.3).
 *
 * "The command creates a one-use ticket recording database time, route and posture
 * versions, actor, device, assignment, and identity, valid for 60 seconds. Command
 * replay returns `already_consumed`, never another allow."
 *
 * Both halves of that last sentence are enforced twice, on purpose.
 *
 *  * The API's command receipt answers a replay that carries the same command id,
 *    and migration 0001 refuses a receipt of kind `authorize_dial` that carries a
 *    result at all, so a replayed receipt has nothing actionable in it.
 *  * `dial_tickets` has `UNIQUE (workspace_id, command_id)`, so a second ticket for
 *    the same command is refused by the database even if it reached this far — by a
 *    different device, say, or after a receipt was archived.
 *
 * Consumption is a single conditional `UPDATE`. Two Macs racing the same ticket:
 * one statement affects one row and the other affects none, and the second is told
 * `already_consumed`. There is no read-then-write and therefore no window.
 */

export type DialResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DialRefusalCode };

const accept = <T>(value: T): DialResult<T> => ({ ok: true, value });
const refuse = <T>(reason: DialRefusalCode): DialResult<T> => ({ ok: false, reason });

export interface IssuedDialTicket {
  readonly ticketId: string;
  readonly e164: string;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly callingIdentityId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly firmTimeZone: string;
  readonly firmLocalTime: string;
}

export interface AuthorizeDialCommandInput extends Omit<AuthorizeDialInput, 'at'> {
  readonly deviceId: string;
  readonly commandId: string;
  /** Database time. Read from the database when the caller does not supply one. */
  readonly at?: string | undefined;
}

/** The ticket's life, from 9.2. Not configurable: it is the contract. */
export const DIAL_TICKET_SECONDS = 60;

export async function authorizeDialCommand(
  context: RepositoryContext,
  input: AuthorizeDialCommandInput,
): Promise<DialResult<IssuedDialTicket>> {
  // The replay check precedes the decision. A replay must not re-evaluate policy:
  // the answer to "may I dial" the second time is not an allow and not a refusal
  // about the firm, it is "you already asked".
  const existing = await context.db.query(
    'SELECT 1 FROM dial_tickets WHERE workspace_id = $1 AND command_id = $2',
    [context.scope.workspaceId, input.commandId],
  );
  if (existing.rows.length > 0) return refuse('already_consumed');

  const at = input.at ?? (await databaseNow(context));
  const decision = await authorizeDial(context, { ...input, at });
  if (!decision.allowed) return refuse(decision.reason);

  const issued = await insertTicket(context, decision.evidence, input);
  if (issued === null) return refuse('already_consumed');

  await recordCrmAuditEvent(context, {
    action: 'dial.authorized',
    subjectKind: 'dial_ticket',
    subjectId: issued.ticketId,
    detail: {
      firmId: issued.firmId,
      routeId: issued.routeId,
      routeVersion: issued.routeVersion,
      postureId: decision.evidence.postureId,
    },
  });
  return accept(issued);
}

interface TicketRow {
  readonly id: string;
  readonly e164: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly phone_route_id: string;
  readonly route_version: number;
  readonly calling_identity_id: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly firm_time_zone: string;
  readonly [column: string]: unknown;
}

const TICKET_COLUMNS = `id, e164, firm_id, contact_id, phone_route_id, route_version, calling_identity_id,
  issued_at, expires_at, firm_time_zone`;

async function insertTicket(
  context: RepositoryContext,
  evidence: DialEvidence,
  input: AuthorizeDialCommandInput,
): Promise<IssuedDialTicket | null> {
  // `issued_at` and `expires_at` are the database's clock and the database's
  // arithmetic. A client that could send either could send itself an hour.
  const { rows } = await context.db.query<TicketRow>(
    `INSERT INTO dial_tickets
       (workspace_id, command_id, firm_id, contact_id, phone_route_id, route_version,
        posture_id, posture_revision, calling_identity_id, actor_user_id, device_id,
        assigned_user_id, e164, firm_time_zone, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             now(), now() + make_interval(secs => $15))
     ON CONFLICT ON CONSTRAINT dial_tickets_one_per_command DO NOTHING
     RETURNING ${TICKET_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.commandId,
      evidence.firmId,
      evidence.contactId,
      evidence.routeId,
      evidence.routeVersion,
      evidence.postureId,
      evidence.postureRevision,
      evidence.callingIdentityId,
      context.scope.actor.kind === 'user' ? context.scope.actor.userId : evidence.assignedUserId,
      input.deviceId,
      evidence.assignedUserId,
      evidence.e164,
      evidence.firmTimeZone,
      DIAL_TICKET_SECONDS,
    ],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ticketId: row.id,
    e164: row.e164,
    firmId: row.firm_id,
    contactId: row.contact_id,
    routeId: row.phone_route_id,
    routeVersion: row.route_version,
    callingIdentityId: row.calling_identity_id,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    firmTimeZone: row.firm_time_zone,
    firmLocalTime: evidence.firmLocalTime,
  };
}

export interface ConsumedTicket {
  readonly ticketId: string;
  readonly e164: string;
  readonly consumedAt: string;
  /** The URI the main process opens. Composed here so the client never builds one. */
  readonly telUri: string;
}

/**
 * Consume a ticket, immediately before the local handoff (9.2).
 *
 * "A ticket is consumed immediately before local handoff. Failure to open the local
 * application permits requesting a new authorization but never reusing the ticket."
 * So there is no un-consume and no retry: the only refusals are unknown, expired,
 * the wrong device, and already consumed.
 *
 * The device is checked because the ticket recorded one. A ticket minted for one Mac
 * and consumed by another is either a bug or a stolen session, and in both cases the
 * answer is no.
 */
export async function consumeDialTicket(
  context: RepositoryContext,
  input: { readonly ticketId: string; readonly deviceId: string },
): Promise<DialResult<ConsumedTicket>> {
  const { rows } = await context.db.query<{ id: string; e164: string; consumed_at: Date }>(
    `UPDATE dial_tickets
        SET consumed_at = now()
      WHERE workspace_id = $1 AND id = $2 AND device_id = $3
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, e164, consumed_at`,
    [context.scope.workspaceId, input.ticketId, input.deviceId],
  );
  const row = rows[0];
  if (row !== undefined) {
    return accept({
      ticketId: row.id,
      e164: row.e164,
      consumedAt: row.consumed_at.toISOString(),
      telUri: `tel:${row.e164}`,
    });
  }

  const state = await context.db.query<{ device_id: string; consumed_at: Date | null; expired: boolean }>(
    'SELECT device_id, consumed_at, (expires_at <= now()) AS expired FROM dial_tickets WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.ticketId],
  );
  const ticket = state.rows[0];
  if (ticket === undefined) return refuse('ticket_unknown');
  if (ticket.device_id !== input.deviceId) return refuse('ticket_wrong_device');
  if (ticket.consumed_at !== null) return refuse('already_consumed');
  return refuse('ticket_expired');
}

export interface DialTicketState {
  readonly ticketId: string;
  readonly e164: string;
  readonly firmId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export async function readDialTicket(
  context: RepositoryContext,
  ticketId: string,
): Promise<DialTicketState | null> {
  const { rows } = await context.db.query<TicketRow & { consumed_at: Date | null }>(
    `SELECT ${TICKET_COLUMNS}, consumed_at FROM dial_tickets WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, ticketId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ticketId: row.id,
    e164: row.e164,
    firmId: row.firm_id,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    consumedAt: row.consumed_at === null ? null : row.consumed_at.toISOString(),
  };
}
