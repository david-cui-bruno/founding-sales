import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededWorkspace, TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';

/**
 * Mail rows for the two-workspace fixture (specification 6, 12.1, Appendix G 8).
 *
 * Both workspaces get a connected mailbox, one incoming message and one match, and
 * the external identifiers collide on purpose: the same Gmail message id, the same
 * thread id, the same RFC Message-ID and the same Pub/Sub message id. Every
 * uniqueness in migration 0009 is per workspace, so all four must be accepted twice
 * and neither workspace may see the other's.
 *
 * No real person, address or business name appears here. `example.test` is reserved
 * by RFC 6761.
 */

export interface SeededMailbox {
  readonly mailboxId: string;
  readonly address: string;
  readonly messageId: string;
  readonly matchId: string;
  readonly holdId: string;
}

export interface SeededMail {
  readonly alpha: SeededMailbox;
  readonly beta: SeededMailbox;
  /** The Gmail message id both workspaces observe. */
  readonly collidingProviderMessageId: string;
  readonly collidingThreadId: string;
  /** The RFC 5322 Message-ID both workspaces observe, stored without brackets. */
  readonly collidingRfcMessageId: string;
  /** The Pub/Sub message id both workspaces are pushed. */
  readonly collidingPushMessageId: string;
  /** The Pub/Sub topic the watch names. A public identifier from the infra module. */
  readonly topicName: string;
}

const COLLIDING_PROVIDER_MESSAGE_ID = '18f2c0a1b2c3d4e5';
const COLLIDING_THREAD_ID = '18f2c0a1b2c3d400';
const COLLIDING_RFC_MESSAGE_ID = 'fss-fixture-1@mail.example.test';
const COLLIDING_PUSH_MESSAGE_ID = '9876543210123456';
export const FIXTURE_TOPIC_NAME = 'projects/callie-fss/topics/fss-prod-gmail-push';

/** The mailbox address of a workspace's salesperson. Distinct per workspace. */
export function mailboxAddressFor(workspace: SeededWorkspace): string {
  return `sales.${workspace.slug}@example.test`;
}

async function seedMailbox(
  session: SessionQueryable,
  workspace: SeededWorkspace,
  crm: { readonly firmId: string; readonly contactId: string; readonly opportunityId: string },
): Promise<SeededMailbox> {
  const mailbox = await session.query<{ id: string }>(
    `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id,
                            sync_state, history_id, history_id_updated_at, coverage_watermark_at,
                            baseline_from_at, baseline_completed_at)
     VALUES ($1, $2, $3, $3, 'ready', '100', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             TIMESTAMPTZ '2026-09-01 12:00:00+00', TIMESTAMPTZ '2026-08-25 12:00:00+00',
             TIMESTAMPTZ '2026-09-01 12:00:00+00')
     RETURNING id`,
    [workspace.workspaceId, workspace.salesperson.userId, mailboxAddressFor(workspace)],
  );
  const mailboxId = mailbox.rows[0]?.id ?? '';

  await session.query(
    `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, provider_history_id,
                                  registered_at, expires_at)
     VALUES ($1, $2, 1, $3, '100', TIMESTAMPTZ '2026-09-01 12:00:00+00', TIMESTAMPTZ '2026-09-08 12:00:00+00')`,
    [workspace.workspaceId, mailboxId, FIXTURE_TOPIC_NAME],
  );

  const message = await session.query<{ id: string }>(
    `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                rfc_message_id, direction, internal_date, header_from, header_to,
                                subject, matched)
     VALUES ($1, $2, $3, $4, $5, 'incoming', TIMESTAMPTZ '2026-09-02 09:00:00+00',
             'dana@northwind.example.test', ARRAY[$6]::text[], 'Re: hello', true)
     RETURNING id`,
    [
      workspace.workspaceId,
      mailboxId,
      COLLIDING_PROVIDER_MESSAGE_ID,
      COLLIDING_THREAD_ID,
      COLLIDING_RFC_MESSAGE_ID,
      mailboxAddressFor(workspace),
    ],
  );
  const messageId = message.rows[0]?.id ?? '';

  const hold = await session.query<{ id: string }>(
    `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
                               source_event_kind, source_event_id)
     VALUES ($1, 'opportunity', $2, 'ambiguous_match', ARRAY['email_send']::text[], 'mail_message', $3)
     RETURNING id`,
    [workspace.workspaceId, crm.opportunityId, messageId],
  );
  const holdId = hold.rows[0]?.id ?? '';

  const match = await session.query<{ id: string }>(
    `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id,
                                       match_rule)
     VALUES ($1, $2, $3, $4, $5, 'thread')
     RETURNING id`,
    [workspace.workspaceId, messageId, crm.firmId, crm.opportunityId, crm.contactId],
  );

  return {
    mailboxId,
    address: mailboxAddressFor(workspace),
    messageId,
    matchId: match.rows[0]?.id ?? '',
    holdId,
  };
}

export async function seedMail(
  session: SessionQueryable,
  seeded: TwoWorkspaces,
  crm: SeededCrm,
): Promise<SeededMail> {
  return {
    alpha: await seedMailbox(session, seeded.alpha, crm.alpha),
    beta: await seedMailbox(session, seeded.beta, crm.beta),
    collidingProviderMessageId: COLLIDING_PROVIDER_MESSAGE_ID,
    collidingThreadId: COLLIDING_THREAD_ID,
    collidingRfcMessageId: COLLIDING_RFC_MESSAGE_ID,
    collidingPushMessageId: COLLIDING_PUSH_MESSAGE_ID,
    topicName: FIXTURE_TOPIC_NAME,
  };
}
