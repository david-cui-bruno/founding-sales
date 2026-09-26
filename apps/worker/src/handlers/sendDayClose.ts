import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import { closeSendDay, listDaysToClose, readSendDayHealth } from '@fss/domain/outbound/ramp.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `outbound.close_send_day` job and the source that materializes it (12.7, 13.1).
 *
 * 12.7's ramp is "a function of one stored number — healthy sending days". G7-2 wrote
 * the function, the table and `closeSendDay`, and nothing called it, so
 * `healthy_sending_days` was zero for every mailbox that has ever existed and the cap
 * was five a day for ever. `docs/greenfield/sending.md` rule 6 read as though the ramp
 * advanced. This is the caller that makes the sentence true.
 *
 * ## When a day closes
 *
 * When the workspace's own business date has moved past it. `mailbox_send_days.
 * business_date` is in the *workspace's* zone — migration 0010 says so beside the
 * column, and distinguishes it from the send *window*, which is in the firm's — so the
 * day is over when that zone's midnight has passed, which is after 17:00 and therefore
 * after every window that day could have had. Nothing here reads a host clock: the
 * date is `(now() AT TIME ZONE w.business_time_zone)::date`, computed by PostgreSQL,
 * the same expression `businessDateOf` uses.
 *
 * ## Why one job per mailbox per day
 *
 * The key is `send-day-close:{mailbox}:{business_date}`, so a workspace whose scheduler
 * was down all night gets each open day closed once on the first pass afterwards, in
 * date order, rather than losing the days — the property `retentionSource` relies on,
 * and the reason neither source needs a "have I run today" flag. The `LIMIT` inside
 * `listDaysToClose` bounds a pass that finds a long backlog; the next minute takes the
 * rest.
 */
export function sendDayCloseJobHandler(
  options: { readonly maxAttempts?: number; readonly leaseSeconds?: number } = {},
): JobHandler {
  return {
    kind: 'outbound.close_send_day',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const mailboxId = input.job.payload['mailboxId'];
      const businessDate = input.job.payload['businessDate'];
      if (typeof mailboxId !== 'string' || typeof businessDate !== 'string') {
        throw new Error('a send-day close names the mailbox and the business date it closes');
      }
      const context = repositoryContext(input.scope, input.session);
      const signals = await readSendDayHealth(context, mailboxId);
      if (signals === null) {
        // The scope found no such mailbox in this workspace. Fail rather than
        // complete: a silent success would hide a payload from somewhere else.
        throw new Error('the send-day close found no such mailbox in its workspace');
      }
      await closeSendDay(context, { mailboxId, businessDate, signals });
    },
  };
}

/** Every workspace, and the open send days its own calendar has moved past. */
export function sendDayCloseSource(): DueWorkSource {
  return {
    name: 'send-day-close',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      const { rows } = await session.query<{ id: string; business_date: string }>(
        `SELECT id, ((now() AT TIME ZONE business_time_zone)::date)::text AS business_date
           FROM workspaces ORDER BY id`,
      );
      const specifications: JobSpecification[] = [];
      for (const workspace of rows) {
        const open = await listDaysToClose(session, workspace.business_date, {
          workspaceId: workspace.id,
        });
        for (const day of open) {
          specifications.push({
            workspaceId: day.workspaceId,
            kind: 'outbound.close_send_day',
            idempotencyKey: jobIdempotencyKey.closeSendDay(day.mailboxId, day.businessDate),
            payload: { mailboxId: day.mailboxId, businessDate: day.businessDate },
            maxAttempts: 4,
          });
        }
      }
      return specifications;
    },
  };
}
