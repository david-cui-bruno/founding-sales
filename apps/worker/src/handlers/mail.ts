import type { JobHandler } from '@fss/domain/jobs';
import {
  MAIL_LEASE_SECONDS,
  mailRecoveryHandler,
  mailSyncHandler,
  watchRenewalHandler,
  type EnvelopeCipher,
  type GmailClient,
  type GmailOAuthConfig,
  type RecoveryFloorSource,
  type ReplyPromoter,
} from '@fss/domain/mail';
import type { SuppressionJournal } from '@fss/domain/suppression';
import { promoteReply } from '@fss/domain/today';

/**
 * The three `mail.*` handlers, composed for this process (12.3, Appendix C).
 *
 * The bodies are in `@fss/domain/mail`, for the reason G4's finalizer and G10's
 * research handlers keep theirs there: everything they touch is domain code, and the
 * at-least-once harness has to register them without importing the worker. What this
 * file owns is the composition — which adapters this deployment was given, and
 * therefore which kinds it is willing to claim.
 *
 * ## A worker with no Gmail configuration registers nothing
 *
 * Exactly as `researchHandlers` does with providers. A deployment that has not been
 * handed a Gmail client, an envelope cipher and a suppression journal leaves
 * `mail.sync`, `mail.recover` and `mail.watch_renew` unclaimed in the queue rather
 * than failing each of them four times and producing three dead jobs and a critical
 * alarm. The queue is durable; the work waits.
 *
 * That is not hypothetical scaffolding: `createGmailHttpClient` and
 * `kmsDataKeyWrapper` are both real, and the only thing standing between this and a
 * running mail worker is the bootstrap that reads the deployment's configuration and
 * builds them. That is a separate reviewed change, because it is the one that
 * introduces live credentials.
 *
 * ## The OAuth configuration is resolved once, at startup
 *
 * `MailSyncDeps` wants a `GmailOAuthConfig`, which contains the client secret, so the
 * secret is read from the injected `SecretProvider` when the process starts and held
 * by this closure for its lifetime — the same lifetime the environment variable it
 * came from already has. What matters, and what is preserved, is that it is never
 * written to a file, a log, a fixture or a literal: `describeSecretProvider` reports
 * the name and not the value, and no code path here puts the config in a log line.
 */

export interface MailWorkerOptions {
  readonly gmail: GmailClient;
  /** Resolved from `MailPublicConfig` plus the injected secret provider, at startup. */
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  /** 10.2: the object-locked journal every suppression is written to before its row. */
  readonly journal: SuppressionJournal;
  /** `todayReplyPromoter()` in production. See `docs/decisions/g7-reply-lane-port.md`. */
  readonly replyPromoter: ReplyPromoter;
  /** The fully qualified Pub/Sub topic `infra/modules/pubsub` outputs. */
  readonly pushTopicName: string;
  /** 12.3's "oldest unresolved outbound message or active enrollment". G7-2 supplies it. */
  readonly recoveryFloor?: RecoveryFloorSource | undefined;
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
}

export function mailHandlers(options: MailWorkerOptions | undefined): readonly JobHandler[] {
  if (options === undefined) return [];

  const pipeline = {
    gmail: options.gmail,
    oauth: options.oauth,
    cipher: options.cipher,
    journal: options.journal,
    replyPromoter: options.replyPromoter,
  };
  const handlerOptions = {
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    leaseSeconds: options.leaseSeconds ?? MAIL_LEASE_SECONDS,
  };

  return [
    mailSyncHandler(
      {
        ...pipeline,
        ...(options.recoveryFloor === undefined ? {} : { recoveryFloor: options.recoveryFloor }),
      },
      handlerOptions,
    ),
    mailRecoveryHandler(pipeline, handlerOptions),
    watchRenewalHandler(
      { gmail: options.gmail, oauth: options.oauth, cipher: options.cipher, topicName: options.pushTopicName },
      // A watch registration is one API call. It keeps the queue's shorter lease
      // rather than the five minutes a sync needs.
      { ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }) },
    ),
  ];
}

/**
 * The production `ReplyPromoter`: G6's `promoteReply`, on the caller's context.
 *
 * This is the whole of the adapter `docs/decisions/g7-reply-lane-port.md` said would
 * replace `pendingReplyPromoter` once `0008_today.sql` landed, and the important
 * thing about it is what it does *not* do. It takes the `RepositoryContext` it is
 * handed and passes it straight through, so the today item is written on the same
 * session, inside the same transaction, as the message, its match candidates and
 * their holds — which is what Appendix A's "Record uncertain or ambiguous reply"
 * means and what the recording fake asserts in the tests. An adapter that opened its
 * own connection would type-check and quietly break the flow.
 *
 * `promoteReply` returns the item id; the port returns nothing, because the mail lane
 * has no use for it and a return value it ignored would invite someone to store it.
 */
export function todayReplyPromoter(): ReplyPromoter {
  return {
    promoteReply: async (context, promotion) => {
      await promoteReply(context, {
        firmId: promotion.firmId,
        ...(promotion.contactId === undefined ? {} : { contactId: promotion.contactId }),
        messageId: promotion.messageId,
        receivedAt: promotion.receivedAt,
      });
    },
  };
}

/** The kinds a fully configured mail worker claims. Read by the startup log line. */
export const MAIL_JOB_KINDS: readonly string[] = Object.freeze([
  'mail.sync',
  'mail.recover',
  'mail.watch_renew',
]);
