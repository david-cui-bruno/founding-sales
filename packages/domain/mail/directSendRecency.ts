import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * How long an agreed-sequence e-mail waits after the salesperson wrote to the same person
 * by hand (send-path v2, S1 review P1-4).
 *
 * David's "prevent duplicate follow-ups": an agreed sequence keeps running after a direct
 * send — one hand-written e-mail does not end a programme the prospect agreed to — but
 * its next e-mail must not land minutes after the salesperson's own. The direct-send
 * effect pushes the next pending e-mail of each such enrollment to at least this long
 * after the send (`applyDirectSendEffects`), and the dispatch claim re-asks under the send
 * gate (`outbound/send.ts`), which also covers a fence that was already prepared.
 */
export const DIRECT_SEND_QUIET_HOURS = 24;

/**
 * Whether a direct send to this person at this firm is younger than the quiet window,
 * by the database's own clock and the message's Gmail `internal_date`.
 *
 * The recipients are the effect's own record of them: its `direct_send_conversation`
 * marker names the verified To/Cc contacts, so this asks exactly the question the effect
 * answered, and a historical `direct_send_manual` marker (which ended everything anyway)
 * is not consulted.
 */
export async function directSendWithinQuietWindow(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly contactId: string },
): Promise<boolean> {
  const { rows } = await context.db.query<{ recent: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM mail_message_effects AS f
         JOIN mail_messages AS m ON m.workspace_id = f.workspace_id AND m.id = f.mail_message_id
        WHERE f.workspace_id = $1
          AND f.effect_kind = 'direct_send_conversation'
          AND f.detail->>'firmId' = $2
          AND (f.detail->'recipientContactIds') ? $3
          AND m.internal_date > clock_timestamp() - make_interval(hours => $4)
     ) AS recent`,
    [context.scope.workspaceId, input.firmId, input.contactId, DIRECT_SEND_QUIET_HOURS],
  );
  return rows[0]?.recent === true;
}
