import type { JobHandler } from '../jobs/handlerRegistry.ts';
import { repositoryContext } from '../db/workspaceScope.ts';
import { payloadMailboxId } from './coalesce.ts';
import { recordMailboxHeartbeat } from './mailboxes.ts';
import { runMailRecovery, type MailRecoveryDeps } from './recover.ts';
import { runMailSync, type MailSyncDeps } from './sync.ts';
import { renewWatch, type WatchRenewalDeps } from './watch.ts';

/**
 * The three `mail.*` handlers of Appendix C (12.3).
 *
 * | Work | Idempotency key | Effect protection |
 * |---|---|---|
 * | Mail sync | `mail-sync:{mailbox}` single-flight with merged high-water ID | Message uniqueness and cursor CAS |
 * | Mail recovery | `mail-recover:{mailbox}:{generation}` | Message uniqueness and coverage watermark |
 * | Watch renewal | `watch:{mailbox}:{generation}` | Stored expiry and generation |
 *
 * The registry refuses a handler whose declared protection disagrees with that table,
 * so the declarations below are checked rather than described. Each is honest:
 *
 * `mail.sync` and `mail.recover` are `business_uniqueness`. Running either twice
 * records each message once (`mail_messages_one_per_provider_id`), applies each effect
 * once (`mail_message_effects_one_per_target`), and moves the cursor once (the
 * compare-and-set). A worker whose lease was stolen has the whole transaction rolled
 * back with its failed completion.
 *
 * `mail.watch_renew` is `fencing_token`, which Appendix C calls "stored expiry and
 * generation" and which is the same thing: the runner locks the job row by its token
 * before the handler runs, and the handler additionally refuses a generation that is
 * not the next one, so a renewal that waited through two others writes nothing.
 *
 * The handler bodies live in `@fss/domain/mail` rather than in `apps/worker` for the
 * reason G4's finalizer does: everything they touch is domain code, and the
 * at-least-once harness in `packages/domain/jobs/atLeastOnce.ts` has to be able to
 * register them without importing the worker. `apps/worker` composes them.
 */

export interface MailHandlerOptions {
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
}

/**
 * Each mail handler talks to Gmail, so its lease is longer than the queue's default
 * sixty seconds: a bounded sync is about fifty metadata reads (it takes whole history
 * records, so the last one may carry it past fifty) and at most as many body reads,
 * and a lease that expires mid-run only causes a second worker to redo work the
 * uniqueness will collapse. Five minutes is comfortably more than a bounded run and
 * comfortably less than a stuck worker's mean time to notice.
 */
export const MAIL_LEASE_SECONDS = 300;

export function mailSyncHandler(deps: MailSyncDeps, options: MailHandlerOptions = {}): JobHandler {
  return {
    kind: 'mail.sync',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? MAIL_LEASE_SECONDS,
    handle: async input => {
      const mailboxId = payloadMailboxId(input.job.payload);
      const context = repositoryContext(input.scope, input.session);
      const report = await runMailSync(context, deps, { mailboxId });
      // 13.3: "Heartbeats cover API, scheduler, worker, and every mailbox." The
      // mailbox proved it is being read, whatever the outcome was, which is what the
      // three-missed-checks alarm asks.
      await recordMailboxHeartbeat(input.session, {
        workspaceId: input.scope.workspaceId,
        mailboxId,
        detail: { outcome: report.outcome, messages: report.messagesSeen, more: report.moreToDo },
      });
      if (report.outcome === 'mailbox_unknown') {
        throw new Error('a mail.sync payload named a mailbox in another workspace');
      }
    },
  };
}

export function mailRecoveryHandler(deps: MailRecoveryDeps, options: MailHandlerOptions = {}): JobHandler {
  return {
    kind: 'mail.recover',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? MAIL_LEASE_SECONDS,
    handle: async input => {
      const mailboxId = payloadMailboxId(input.job.payload);
      const generation = input.job.payload['generation'];
      if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
        throw new Error('a mail.recover payload names the generation it is recovering');
      }
      const context = repositoryContext(input.scope, input.session);
      const report = await runMailRecovery(context, deps, { mailboxId, generation });
      await recordMailboxHeartbeat(input.session, {
        workspaceId: input.scope.workspaceId,
        mailboxId,
        detail: { outcome: report.outcome, pages: report.pagesCompleted },
      });
      if (report.outcome === 'mailbox_unknown') {
        throw new Error('a mail.recover payload named a mailbox in another workspace');
      }
    },
  };
}

export function watchRenewalHandler(deps: WatchRenewalDeps, options: MailHandlerOptions = {}): JobHandler {
  return {
    kind: 'mail.watch_renew',
    protection: 'fencing_token',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const mailboxId = payloadMailboxId(input.job.payload);
      const generation = input.job.payload['generation'];
      if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
        throw new Error('a mail.watch_renew payload names the generation it is registering');
      }
      const context = repositoryContext(input.scope, input.session);
      const report = await renewWatch(context, deps, { mailboxId, generation });
      if (report.outcome === 'mailbox_unknown') {
        throw new Error('a mail.watch_renew payload named a mailbox in another workspace');
      }
      if (report.outcome === 'provider_refusal') {
        // Retryable: Gmail refused the watch for a reason that is not the grant, and
        // the backoff ladder is the right answer. A mailbox with no live watch is
        // already reporting zero hours to expiry, so the alarm is not waiting on this.
        throw new Error('Gmail refused the watch registration');
      }
    },
  };
}
