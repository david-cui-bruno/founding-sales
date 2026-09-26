import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededWorkspace, TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { SeededMail } from './mailFixtures.ts';

/**
 * Rows on both sides of every 10.3 boundary, in both workspaces.
 *
 * Appendix G scenario 41 is "retention deletes unmatched metadata, raw MIME,
 * canceled drafts, and logs at their boundaries without deleting matched business
 * history or suppression tombstones", so a fixture that only seeds expired rows can
 * prove half of it. Every kind here gets two rows: one comfortably past its horizon
 * and one comfortably inside it. A sweep that takes the second is as wrong as a
 * sweep that leaves the first.
 *
 * The instants are literals rather than offsets from `now()` for the reason
 * migrations seed at a named constant: a fixture that is relative to the clock is a
 * fixture that behaves differently at 23:59.
 *
 * No real person, address or business appears. `example.test` is reserved by RFC
 * 6761 and any number is in the NANP 555-01XX fictional block.
 */

/** Database time every retention test passes as `now`. */
export const RETENTION_NOW = '2026-09-20T12:00:00.000Z';

/** Comfortably past the 30-day and 7-day horizons. */
const LONG_AGO = '2026-06-01T09:00:00+00';
/** Inside every horizon in the table. */
const YESTERDAY = '2026-09-19T09:00:00+00';

export interface SeededRetentionSide {
  /** Unmatched Gmail metadata recorded long ago. The 30-day rule takes this one. */
  readonly expiredUnmatchedMessageId: string;
  /** Unmatched, but recorded yesterday. Nothing may take this one. */
  readonly freshUnmatchedMessageId: string;
  /** Matched business correspondence recorded long ago, with a body. Retained. */
  readonly matchedMessageId: string;
  /** A Pub/Sub notification from long ago: temporary mailbox material, seven days. */
  readonly expiredPushNotificationId: string;
  readonly freshPushNotificationId: string;
  /** A completed recovery from long ago: mailbox diagnostics, seven days. */
  readonly expiredRecoveryId: string;
  /** Evidence whose provider terms have expired, and evidence whose terms have not. */
  readonly expiredEvidenceId: string;
  readonly liveEvidenceId: string;
  /** A completed job whose payload is past the operational window, and a recent one. */
  readonly oldJobId: string;
  readonly recentJobId: string;
  /** A held, never-dispatched draft fence past the thirty-day rule, and one inside it. */
  readonly expiredDraftFenceId: string;
  readonly freshDraftFenceId: string;
  /** A sent fence: business correspondence, and the envelope trigger forbids touching it. */
  readonly sentFenceId: string;
  /** The minimal normalized suppression tombstone that must survive every job. */
  readonly tombstoneEventId: string;
  readonly tombstoneKey: string;
}

export interface SeededRetention {
  readonly alpha: SeededRetentionSide;
  readonly beta: SeededRetentionSide;
}

const id = (rows: readonly { readonly id: string }[]): string => rows[0]?.id ?? '';

async function seedSide(
  session: SessionQueryable,
  workspace: SeededWorkspace,
  crm: { readonly firmId: string; readonly contactId: string; readonly opportunityId: string },
  mailbox: { readonly mailboxId: string; readonly address: string },
): Promise<SeededRetentionSide> {
  const message = async (
    providerId: string,
    recordedAt: string,
    matched: boolean,
  ): Promise<string> => {
    const { rows } = await session.query<{ id: string }>(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                  direction, internal_date, header_from, header_to, subject,
                                  matched, metadata_only, recorded_at, attachment_references)
       VALUES ($1, $2, $3, $3, 'incoming', $4::timestamptz, 'dana@northwind.example.test',
               ARRAY[$5]::text[], 'Re: scheduling', $6, NOT $6, $4::timestamptz,
               '[{"filename":"terms.pdf","mimeType":"application/pdf","sizeBytes":900,"attachmentId":"att-1"}]'::jsonb)
       RETURNING id`,
      [workspace.workspaceId, mailbox.mailboxId, providerId, recordedAt, mailbox.address, matched],
    );
    return id(rows);
  };

  const expiredUnmatchedMessageId = await message('retention_expired_unmatched', LONG_AGO, false);
  const freshUnmatchedMessageId = await message('retention_fresh_unmatched', YESTERDAY, false);
  const matchedMessageId = await message('retention_matched_history', LONG_AGO, true);

  await session.query(
    `INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text, fetched_at)
     VALUES ($1, $2, 'Thanks, that works for us.', $3::timestamptz)`,
    [workspace.workspaceId, matchedMessageId, LONG_AGO],
  );
  await session.query(
    `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id, match_rule)
     VALUES ($1, $2, $3, $4, $5, 'thread')`,
    [workspace.workspaceId, matchedMessageId, crm.firmId, crm.opportunityId, crm.contactId],
  );

  const push = async (providerMessageId: string, receivedAt: string): Promise<string> => {
    const { rows } = await session.query<{ id: string }>(
      `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id, history_id, received_at)
       VALUES ($1, $2, $3, '4242', $4::timestamptz)
       RETURNING id`,
      [workspace.workspaceId, mailbox.mailboxId, providerMessageId, receivedAt],
    );
    return id(rows);
  };
  const expiredPushNotificationId = await push('retention-push-expired', LONG_AGO);
  const freshPushNotificationId = await push('retention-push-fresh', YESTERDAY);

  const recovery = await session.query<{ id: string }>(
    `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at,
                                     started_at, completed_at)
     VALUES ($1, $2, 7, 'history_expired', $3::timestamptz, $3::timestamptz + INTERVAL '1 hour',
             $3::timestamptz, $3::timestamptz + INTERVAL '2 hours')
     RETURNING id`,
    [workspace.workspaceId, mailbox.mailboxId, LONG_AGO],
  );

  const evidence = async (contentHash: string, expiresAt: string | null): Promise<string> => {
    const { rows } = await session.query<{ id: string }>(
      `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, retrieved_at,
                                   terms_allow_retention, retention_expires_at, content_hash)
       VALUES ($1, $2, 'places', 'https://provider.example.test/result', $3::timestamptz,
               $4::timestamptz IS NULL, $4::timestamptz, $5)
       RETURNING id`,
      [workspace.workspaceId, crm.firmId, LONG_AGO, expiresAt, contentHash],
    );
    return id(rows);
  };
  const expiredEvidenceId = await evidence('a'.repeat(64), '2026-07-01T00:00:00+00');
  const liveEvidenceId = await evidence('b'.repeat(64), null);

  // `null` is yesterday by the database's clock: the job-payload sweep
  // (`archiveCompletedPayloads`) measures its seven days from `now()`, not from
  // RETENTION_NOW, so a fixed "yesterday" ages out of the window a week later.
  const job = async (key: string, completedAt: string | null): Promise<string> => {
    const { rows } = await session.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state, run_at, completed_at)
       VALUES ($1, 'today.build', '{"firmId":"a-prospect"}'::jsonb, $2, 'done',
               COALESCE($3::timestamptz, now() - interval '1 day'), COALESCE($3::timestamptz, now() - interval '1 day'))
       RETURNING id`,
      [workspace.workspaceId, key, completedAt],
    );
    return id(rows);
  };
  const oldJobId = await job('retention-old-job', LONG_AGO);
  const recentJobId = await job('retention-recent-job', null);

  // Outbound fences (migration 0010). Two held drafts on either side of the
  // thirty-day boundary, and one sent fence, because `canceled_drafts` must take the
  // first and leave the other two — the second is inside its horizon and the third
  // is correspondence that left.
  const fence = async (
    label: string,
    state: 'held' | 'sent',
    at: string,
  ): Promise<string> => {
    const sent = state === 'sent';
    const { rows } = await session.query<{ id: string }>(
      `INSERT INTO outbound_messages
         (workspace_id, mailbox_id, state, origin_kind, draft_id, firm_id, recipient_address,
          subject, body, rendered_hash, provider_message_id_header, send_at, source_zone,
          placement_rule_version, held_at, held_reason, attempt_token, dispatch_started_at,
          sent_at, provider_message_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'draft', gen_random_uuid(), $4, 'dana@northwind.example.test',
               $5, 'The draft nobody sent.', $6, $7, $8::timestamptz, 'America/New_York',
               'placement.1',
               CASE WHEN $3 = 'held' THEN $8::timestamptz END,
               CASE WHEN $3 = 'held' THEN 'daily_cap' END,
               CASE WHEN $9 THEN gen_random_uuid() END,
               CASE WHEN $9 THEN $8::timestamptz END,
               CASE WHEN $9 THEN $8::timestamptz END,
               CASE WHEN $9 THEN 'provider-' || $5 END,
               $8::timestamptz, $8::timestamptz)
       RETURNING id`,
      [
        workspace.workspaceId,
        mailbox.mailboxId,
        state,
        crm.firmId,
        label,
        'c'.repeat(64),
        `<fss.${label}.${workspace.slug}@example.test>`,
        at,
        sent,
      ],
    );
    return id(rows);
  };
  const expiredDraftFenceId = await fence('expired-draft', 'held', LONG_AGO);
  const freshDraftFenceId = await fence('fresh-draft', 'held', YESTERDAY);
  const sentFenceId = await fence('sent-long-ago', 'sent', LONG_AGO);

  // The tombstone. Handle-scoped, normalized and sourced `deletion_tombstone`,
  // which is all 10.3 asks a deletion to leave behind, and inserted here so every
  // retention test can assert it is still there afterwards. The source is the point
  // of the row as much as the key is: it is what makes the audit trail say an admin
  // deleted a record rather than that a prospect asked to be left alone.
  const tombstoneKey = 'erased.person@northwind.example.test';
  const tombstoneEventId = `retention-tombstone-${workspace.slug}`;
  await session.query(
    `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version,
                                     source, recorded_at)
     VALUES ($1, $2, 'handle', $3, 'v1', 'deletion_tombstone', $4::timestamptz)`,
    [workspace.workspaceId, tombstoneEventId, tombstoneKey, LONG_AGO],
  );

  return {
    expiredUnmatchedMessageId,
    freshUnmatchedMessageId,
    matchedMessageId,
    expiredPushNotificationId,
    freshPushNotificationId,
    expiredRecoveryId: id(recovery.rows),
    expiredEvidenceId,
    liveEvidenceId,
    oldJobId,
    recentJobId,
    expiredDraftFenceId,
    freshDraftFenceId,
    sentFenceId,
    tombstoneEventId,
    tombstoneKey,
  };
}

export async function seedRetention(
  session: SessionQueryable,
  seeded: TwoWorkspaces,
  crm: SeededCrm,
  mail: SeededMail,
): Promise<SeededRetention> {
  return {
    alpha: await seedSide(session, seeded.alpha, crm.alpha, mail.alpha),
    beta: await seedSide(session, seeded.beta, crm.beta, mail.beta),
  };
}
