import type { SessionQueryable } from '@fss/domain/db';
import { jobIdempotencyKey, type JobSpecification } from '@fss/domain/jobs';
import {
  coalesceMailSync,
  listIncompleteRecoveries,
  listMailboxesDueForSync,
  listWatchesDue,
  rearmRecoveryJob,
} from '@fss/domain/mail';
import { listMailboxesToReconcile } from '@fss/domain/outbound';
import type { DueWorkSource } from './schedulerPass.ts';

/**
 * The three mail due-work sources the one-minute pass reads (13.1, 12.3).
 *
 * All three exist because of one fact about Appendix C's mail keys: none of them
 * carries an instant. `mail-sync:{mailbox}` and `mail-recover:{mailbox}:{generation}`
 * are single-flight rows that outlive the run, which is exactly what makes a hundred
 * pushes one sync — and exactly why `enqueueJob`'s `ON CONFLICT DO NOTHING` cannot
 * put a finished one back on the queue. So two of these sources do their own
 * idempotent upsert inside the pass's transaction and return no specification, while
 * the third, watch renewal, composes a fresh generation into its key every time and
 * is an ordinary insert.
 *
 * That is also why a mail job never re-arms itself. A handler runs inside the
 * runner's transaction while its own row is `running`; a `coalesceMailSync` from in
 * there would merge into the row that is about to be marked `done` and the
 * continuation would vanish at COMMIT. The continuation is always here, one minute
 * later, on a connection that is not the runner's.
 *
 * None of these sources talks to anything but PostgreSQL, which 13.1 requires of the
 * pass: "it performs no external action".
 */

/**
 * 12.3's reconciliation sweep, which is also 13.3's mailbox check.
 *
 * Push is a hint. A watch can lapse, Pub/Sub can exhaust its retention while the API
 * is down, the webhook can refuse a token through a rotation — and every one of those
 * is silent. This is the backstop that makes the worst case a minute of latency
 * instead of a mailbox that quietly stopped importing mail. It is also what continues
 * a sync that stopped at its page cap.
 *
 * It asks for one check of every connected, `ready` mailbox on **every** pass, so a
 * mailbox with no new mail is still read once a minute and its heartbeat means what
 * the `mailbox_heartbeat_missed` alarm reads it as (`MAILBOX_CHECK_INTERVAL_SECONDS`,
 * lane g58). Until 24 September 2026 it asked only for a mailbox five minutes past its
 * last sync, and the alarm fired between healthy checks.
 *
 * `coalesceMailSync` rather than `enqueueJob`, so a mailbox with a queued or `running`
 * sync merges rather than duplicating, and a mailbox with a `dead` sync stays dead:
 * 13.2 makes reviving an exhausted job an audited admin command, and a scheduler is
 * not an admin. The dead-job alarm is what gets somebody's attention, and the mailbox
 * heartbeat goes stale beside it, which is true.
 */
export function mailSyncReconciliationSource(): DueWorkSource {
  return {
    name: 'mail-sync-reconcile',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      for (const mailbox of await listMailboxesDueForSync(session)) {
        // No history id: the run reads from the stored cursor. A reconciliation has
        // no hint to offer and must not lower a hint a notification already left.
        await coalesceMailSync(session, {
          workspaceId: mailbox.workspaceId,
          mailboxId: mailbox.mailboxId,
          historyId: null,
        });
      }
      return [];
    },
  };
}

/**
 * Every recovery that has not finished gets its job put back.
 *
 * A recovery is deliberately bounded — a page of five hundred ids at a time — so the
 * ordinary case is a `mail.recover` that completes one page, records
 * `pages_completed`, and is done. Without this source a mailbox's baseline would stop
 * after its first page and its coverage hold would never be released.
 *
 * Only the mailbox's current generation is re-armed. An older one has been superseded
 * and its handler would refuse to write anyway, so re-arming it would burn four
 * attempts a minute to reach a `generation_superseded`.
 */
export function mailRecoverySource(): DueWorkSource {
  return {
    name: 'mail-recovery',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      const specifications: JobSpecification[] = [];
      for (const recovery of await listIncompleteRecoveries(session)) {
        const rearmed = await rearmRecoveryJob(session, recovery);
        if (rearmed) continue;
        // Not re-armed means one of two things: the job is still queued, running or
        // dead — in which case the insert below is an `ON CONFLICT DO NOTHING` that
        // correctly leaves it alone — or the row is missing entirely, which is the
        // case worth having, because a recovery with no job is a mailbox whose
        // coverage hold would never lift.
        specifications.push({
          workspaceId: recovery.workspaceId,
          kind: 'mail.recover',
          idempotencyKey: jobIdempotencyKey.mailRecover(recovery.mailboxId, recovery.generation),
          payload: { mailboxId: recovery.mailboxId, generation: recovery.generation },
          maxAttempts: 4,
        });
      }
      return specifications;
    },
  };
}

/**
 * Renew a Gmail watch before it lapses.
 *
 * A Gmail watch expires after seven days and a lapsed watch is silent: no error, no
 * notification, just a mailbox that stops producing push. `listWatchesDue` returns
 * every connected mailbox with no live watch or one inside the renewal window, and
 * the *next* generation, so the key is `watch:{mailbox}:{next}` and a pass that
 * repeats within the minute composes the same key and inserts nothing twice.
 *
 * This is an ordinary `enqueueJob`: the generation makes the key new every renewal,
 * which is what `fencing_token` protection wants — a renewal that waited through two
 * others finds its generation is no longer the next one and writes nothing.
 */
export function watchRenewalSource(): DueWorkSource {
  return {
    name: 'mail-watch-renewal',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const due = await listWatchesDue(session, now);
      return due.map(watch => ({
        workspaceId: watch.workspaceId,
        kind: 'mail.watch_renew',
        idempotencyKey: jobIdempotencyKey.watchRenew(watch.mailboxId, watch.generation),
        payload: { mailboxId: watch.mailboxId, generation: watch.generation },
        maxAttempts: 4,
      }));
    },
  };
}

/**
 * Every mailbox with a fence owed an observation (12.5, Appendix B).
 *
 * Appendix C's key is `mail-reconcile:{mailbox}:{minute}`, so this is the one mail
 * source whose key carries an instant — which means an ordinary `enqueueJob` is
 * exactly right, and the minute is what stops a pass that repeats inside one minute
 * from inserting twice.
 *
 * The unit is the mailbox rather than the fence, deliberately. A mailbox with twenty
 * fences in doubt needs one access token and one job, not twenty of each, and the
 * handler bounds how many it observes per claim.
 *
 * It runs unconditionally, like the others, because an unobserved fence is the worst
 * state in this system to leave quiet: a send nobody will ever know the outcome of.
 */
export function outboundReconcileSource(): DueWorkSource {
  return {
    name: 'outbound-reconcile',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const minute = `${now.slice(0, 16)}Z`;
      const due = await listMailboxesToReconcile(session);
      return due.map(entry => ({
        workspaceId: entry.workspaceId,
        kind: 'mail.reconcile',
        idempotencyKey: jobIdempotencyKey.mailReconcile(entry.mailboxId, minute),
        payload: { mailboxId: entry.mailboxId },
        maxAttempts: 4,
      }));
    },
  };
}

/** All four, in the order the pass should read them. */
export function mailSources(): readonly DueWorkSource[] {
  return [
    mailRecoverySource(),
    mailSyncReconciliationSource(),
    watchRenewalSource(),
    outboundReconcileSource(),
  ];
}
