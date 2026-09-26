import type { TodayItemKind, TodaySource } from '../today/index.ts';
import { isStepChannel, type StepChannel } from './types.ts';

/**
 * Lane 3 of the Today list: due sequence work (specification 8.2).
 *
 * "Lane precedence is: 1 Replies ... 2 Callbacks ... 3 Due sequence work ... 4 New
 * firms. ... Its card shows aggregate counts such as replies, emails due, calls due"
 * (LinkedIn tasks due went with LinkedIn on 25 September 2026).
 *
 * Two of the three counts are this source's, and they are two `TodayItemKind`s over
 * one lane, exactly as `packages/domain/today/types.ts` anticipated. G6 left the
 * `step_execution` source kind in its closed set for this, so nothing in the Today
 * lane changes when this array entry is added to `defaultTodaySources()`.
 *
 * ## What counts as due
 *
 * A `pending` or `held` execution whose due instant falls on or before the business
 * date being built. Held on purpose: 11.2 holds a step rather than skipping it, and a
 * step held because a mailbox is disconnected is exactly the work a salesperson needs
 * to see on their morning list — the card is how they find out. A `dispatched` row is
 * the sending lane's and is not a task anybody can do.
 *
 * ## The item key
 *
 * `step-execution:{id}`, which is also Appendix C's idempotency key for the job that
 * runs it. The same identity in both places means a rebuild upserts the task it
 * already had, and a worker claiming the job and a card showing the task are
 * demonstrably about the same row.
 *
 * A step whose channel is not one `isStepChannel` knows — a LinkedIn task stored before
 * 25 September 2026 — is nobody's task and is not listed. Migration 0018 deleted the
 * `linkedin_due` items earlier builds made, and the kind is gone from the schema.
 */

const KIND_OF_CHANNEL: Readonly<Record<StepChannel, TodayItemKind>> = Object.freeze({
  email: 'email_due',
  call_task: 'call_due',
});

export function dueSequenceWorkSource(): TodaySource {
  return {
    name: 'due-sequence-work',
    sourceKinds: ['step_execution'],
    find: async (context, input) => {
      const { rows } = await context.db.query<{
        id: string;
        firm_id: string;
        contact_id: string;
        channel: string;
        due_at: Date;
      }>(
        `SELECT e.id, e.firm_id, e.contact_id, e.channel, e.due_at
           FROM step_executions e
           JOIN sequence_enrollments n
             ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
           JOIN firms f ON f.workspace_id = e.workspace_id AND f.id = e.firm_id
          WHERE e.workspace_id = $1
            AND e.state IN ('pending', 'held')
            AND n.ended_at IS NULL
            AND f.status = 'active'
            AND (e.due_at AT TIME ZONE $2)::date <= $3::date
          ORDER BY e.due_at, e.id`,
        [context.scope.workspaceId, input.businessTimeZone, input.businessDate],
      );
      return rows.flatMap(row => {
        const channel = row.channel;
        if (!isStepChannel(channel)) return [];
        return [
          {
            firmId: row.firm_id,
            contactId: row.contact_id,
            itemKey: `step-execution:${row.id}`,
            kind: KIND_OF_CHANNEL[channel],
            dueAt: row.due_at.toISOString(),
            sourceKind: 'step_execution' as const,
            sourceId: row.id,
            // 8.2: "Automated sends are not snoozed ad hoc; delaying them creates a
            // recorded hold." An email step is the automated one; a call task is a thing
            // a person does and may snooze.
            automated: channel === 'email',
          },
        ];
      });
    },
  };
}
