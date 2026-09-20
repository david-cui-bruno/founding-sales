import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import { firstStageId } from './crmFixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
import { FIXTURE_TOPIC_NAME } from './mailFixtures.ts';

/**
 * A failing insert for every constraint migration 0009 adds (lane G7: mailboxes,
 * envelope-encrypted tokens, watches, recoveries, push notifications, messages,
 * bodies, matches, classifications, effects and the minimal template version).
 *
 * Same rules as `crmCases.ts` and `policyCases.ts`: their own file so two lanes
 * never edit the middle of one array, each case inside a transaction the caller
 * rolls back, and each row breaking exactly one thing — a row that breaks two is
 * reported under whichever index or check PostgreSQL reaches first, and the case
 * would be testing the wrong promise.
 *
 * No real person, address, business name or credential appears here. Every byte
 * string is a constant pattern, never key material.
 */

export interface MailCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
  readonly mail: SeededMail;
}

export interface MailCase {
  readonly constraint: string;
  readonly run: (fixture: MailCaseFixture) => Promise<unknown>;
}

const workspace = (f: MailCaseFixture): string => f.seeded.alpha.workspaceId;
const admin = (f: MailCaseFixture): string => f.seeded.alpha.admin.userId;
const salesperson = (f: MailCaseFixture): string => f.seeded.alpha.salesperson.userId;
const otherWorkspaceUser = (f: MailCaseFixture): string => f.seeded.beta.salesperson.userId;
const mailbox = (f: MailCaseFixture): string => f.mail.alpha.mailboxId;
const message = (f: MailCaseFixture): string => f.mail.alpha.messageId;
const firm = (f: MailCaseFixture): string => f.crm.alpha.firmId;
const opportunity = (f: MailCaseFixture): string => f.crm.alpha.opportunityId;
const contact = (f: MailCaseFixture): string => f.crm.alpha.contactId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';
const HASH = 'a'.repeat(64);
const AT = "TIMESTAMPTZ '2026-09-02 09:00:00+00'";
const EARLIER = "TIMESTAMPTZ '2026-09-01 09:00:00+00'";
const LATER = "TIMESTAMPTZ '2026-09-03 09:00:00+00'";

/** Twelve bytes of a constant pattern: the right length for an AES-GCM nonce. */
const IV = "decode(repeat('0a', 12), 'hex')";
const TAG = "decode(repeat('0b', 16), 'hex')";
const WRAPPED = "decode(repeat('0c', 32), 'hex')";
const CIPHERTEXT = "decode(repeat('0d', 64), 'hex')";
const EMPTY_BYTES = "decode('', 'hex')";

/** An approvable body: it ends with the reply-to-stop line and names no web link. */
const BODY = 'Hello.\n\nSigned off\n1 Example Way\nReply "stop" and I will not email you again.';

let sequence = 0;
/** A value unique within one case run, so a case never trips uniqueness by accident. */
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

/** A second firm and open opportunity in the alpha workspace. */
async function anotherOpportunity(
  f: MailCaseFixture,
): Promise<{ readonly firmId: string; readonly opportunityId: string }> {
  const created = await f.session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [workspace(f), unique('Another Test Firm '), salesperson(f)],
  );
  const firmId = created.rows[0]?.id ?? '';
  const stageId = await firstStageId(f.session, workspace(f));
  const opened = await f.session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, ${AT}) RETURNING id`,
    [workspace(f), firmId, stageId],
  );
  return { firmId, opportunityId: opened.rows[0]?.id ?? '' };
}

/** A mailbox insert with the given column list, owned by the admin unless overridden. */
async function insertMailbox(
  f: MailCaseFixture,
  columns: string,
  values: string,
  parameters: readonly unknown[] = [],
): Promise<unknown> {
  return await f.session.query(`INSERT INTO mailboxes (${columns}) VALUES (${values})`, [...parameters]);
}

export const MAIL_CONSTRAINT_CASES: readonly MailCase[] = [
  // ------------------------------------------------------------------ mailboxes
  {
    constraint: 'mailboxes_pkey',
    run: async f =>
      await insertMailbox(
        f,
        'id, workspace_id, owner_user_id, email_address',
        '$1, $2, $3, $4',
        [mailbox(f), workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_workspace_id_fkey',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address', '$1, $2, $3', [
        MISSING,
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_owner_fkey',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address', '$1, $2, $3', [
        workspace(f),
        otherWorkspaceUser(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_one_per_owner',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address', '$1, $2, $3', [
        workspace(f),
        salesperson(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_one_per_address',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address', '$1, $2, $3', [
        workspace(f),
        admin(f),
        f.mail.alpha.address,
      ]),
  },
  {
    constraint: 'mailboxes_kind_known',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address, kind', "$1, $2, $3, 'team'", [
        workspace(f),
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_shared_kind_disabled',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address, kind', "$1, $2, $3, 'shared'", [
        workspace(f),
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_status_known',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, status, disconnected_at',
        `$1, $2, $3, 'paused', ${AT}`,
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_address_shape',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address', "$1, $2, 'Not An Address'", [
        workspace(f),
        admin(f),
      ]),
  },
  {
    constraint: 'mailboxes_provider_account_shape',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, provider_account_id',
        "$1, $2, $3, '   '",
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_generation_positive',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address, generation', '$1, $2, $3, 0', [
        workspace(f),
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_sync_state_known',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address, sync_state', "$1, $2, $3, 'guessing'", [
        workspace(f),
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_disconnect_consistent',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, disconnected_at',
        `$1, $2, $3, ${AT}`,
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_disconnect_reason_bounded',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, status, disconnected_at, disconnect_reason',
        `$1, $2, $3, 'disconnected', ${AT}, '   '`,
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_history_id_shape',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, history_id, history_id_updated_at',
        `$1, $2, $3, 'not-a-number', ${AT}`,
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_history_cursor_consistent',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address, history_id', "$1, $2, $3, '42'", [
        workspace(f),
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_coverage_needs_cursor',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, coverage_watermark_at',
        `$1, $2, $3, ${AT}`,
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_baseline_consistent',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, baseline_completed_at',
        `$1, $2, $3, ${AT}`,
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },
  {
    constraint: 'mailboxes_ready_has_baseline',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address, sync_state', "$1, $2, $3, 'ready'", [
        workspace(f),
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_last_sync_error_bounded',
    run: async f =>
      await insertMailbox(f, 'workspace_id, owner_user_id, email_address, last_sync_error', "$1, $2, $3, '  '", [
        workspace(f),
        admin(f),
        `${unique('spare')}@example.test`,
      ]),
  },
  {
    constraint: 'mailboxes_updated_not_before_created',
    run: async f =>
      await insertMailbox(
        f,
        'workspace_id, owner_user_id, email_address, created_at, updated_at',
        `$1, $2, $3, ${LATER}, ${EARLIER}`,
        [workspace(f), admin(f), `${unique('spare')}@example.test`],
      ),
  },

  // ------------------------------------------------------------- mailbox_tokens
  {
    constraint: 'mailbox_tokens_pkey',
    run: async f => {
      const columns = `workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag`;
      const values = `$1, $2, 'alias/test-envelope', ${WRAPPED}, ${CIPHERTEXT}, ${IV}, ${TAG}`;
      await f.session.query(`INSERT INTO mailbox_tokens (${columns}) VALUES (${values})`, [
        workspace(f),
        mailbox(f),
      ]);
      return await f.session.query(`INSERT INTO mailbox_tokens (${columns}) VALUES (${values})`, [
        workspace(f),
        mailbox(f),
      ]);
    },
  },
  {
    constraint: 'mailbox_tokens_mailbox_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag)
         VALUES ($1, $2, 'alias/test-envelope', ${WRAPPED}, ${CIPHERTEXT}, ${IV}, ${TAG})`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'mailbox_tokens_key_id_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag)
         VALUES ($1, $2, '   ', ${WRAPPED}, ${CIPHERTEXT}, ${IV}, ${TAG})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_tokens_algorithm_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, algorithm, wrapped_data_key, ciphertext, iv, auth_tag)
         VALUES ($1, $2, 'alias/test-envelope', 'aes-128-cbc', ${WRAPPED}, ${CIPHERTEXT}, ${IV}, ${TAG})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_tokens_wrapped_key_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag)
         VALUES ($1, $2, 'alias/test-envelope', ${EMPTY_BYTES}, ${CIPHERTEXT}, ${IV}, ${TAG})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_tokens_ciphertext_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag)
         VALUES ($1, $2, 'alias/test-envelope', ${WRAPPED}, ${EMPTY_BYTES}, ${IV}, ${TAG})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_tokens_iv_length',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag)
         VALUES ($1, $2, 'alias/test-envelope', ${WRAPPED}, ${CIPHERTEXT}, decode(repeat('0a', 11), 'hex'), ${TAG})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_tokens_auth_tag_length',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag)
         VALUES ($1, $2, 'alias/test-envelope', ${WRAPPED}, ${CIPHERTEXT}, ${IV}, decode(repeat('0b', 15), 'hex'))`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_tokens_rotated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag,
                                     created_at, rotated_at)
         VALUES ($1, $2, 'alias/test-envelope', ${WRAPPED}, ${CIPHERTEXT}, ${IV}, ${TAG}, ${LATER}, ${EARLIER})`,
        [workspace(f), mailbox(f)],
      ),
  },

  // ------------------------------------------------------------ mailbox_watches
  {
    constraint: 'mailbox_watches_pkey',
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>(
        'SELECT id FROM mailbox_watches WHERE workspace_id = $1 AND mailbox_id = $2',
        [workspace(f), mailbox(f)],
      );
      return await f.session.query(
        `INSERT INTO mailbox_watches (id, workspace_id, mailbox_id, generation, topic_name, registered_at,
                                      expires_at, cancelled_at, cancelled_reason)
         VALUES ($1, $2, $3, 2, $4, ${AT}, ${LATER}, ${LATER}, 'renewed')`,
        [rows[0]?.id, workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      );
    },
  },
  {
    constraint: 'mailbox_watches_mailbox_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at)
         VALUES ($1, $2, 1, $3, ${AT}, ${LATER})`,
        [workspace(f), MISSING, FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_one_per_generation',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at,
                                      cancelled_at, cancelled_reason)
         VALUES ($1, $2, 1, $3, ${AT}, ${LATER}, ${LATER}, 'renewed')`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_one_current',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at)
         VALUES ($1, $2, 2, $3, ${AT}, ${LATER})`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_generation_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at,
                                      cancelled_at, cancelled_reason)
         VALUES ($1, $2, 0, $3, ${AT}, ${LATER}, ${LATER}, 'renewed')`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_topic_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at,
                                      cancelled_at, cancelled_reason)
         VALUES ($1, $2, 2, 'gmail-push', ${AT}, ${LATER}, ${LATER}, 'renewed')`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_watches_history_id_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, provider_history_id,
                                      registered_at, expires_at, cancelled_at, cancelled_reason)
         VALUES ($1, $2, 2, $3, 'zero', ${AT}, ${LATER}, ${LATER}, 'renewed')`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_expiry_after_registration',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at,
                                      cancelled_at, cancelled_reason)
         VALUES ($1, $2, 2, $3, ${LATER}, ${AT}, ${LATER}, 'renewed')`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_cancellation_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at,
                                      cancelled_at)
         VALUES ($1, $2, 2, $3, ${AT}, ${LATER}, ${LATER})`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_cancelled_reason_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at,
                                      cancelled_at, cancelled_reason)
         VALUES ($1, $2, 2, $3, ${AT}, ${LATER}, ${LATER}, '   ')`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },
  {
    constraint: 'mailbox_watches_cancelled_not_before_registration',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, registered_at, expires_at,
                                      cancelled_at, cancelled_reason)
         VALUES ($1, $2, 2, $3, ${AT}, ${LATER}, ${EARLIER}, 'renewed')`,
        [workspace(f), mailbox(f), FIXTURE_TOPIC_NAME],
      ),
  },

  // --------------------------------------------------------- mailbox_recoveries
  {
    constraint: 'mailbox_recoveries_pkey',
    run: async f => {
      const columns = 'id, workspace_id, mailbox_id, generation, reason, from_at, to_at';
      const first = await f.session.query<{ id: string }>(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
         VALUES ($1, $2, 1, 'history_expired', ${EARLIER}, ${AT}) RETURNING id`,
        [workspace(f), mailbox(f)],
      );
      return await f.session.query(
        `INSERT INTO mailbox_recoveries (${columns})
         VALUES ($1, $2, $3, 2, 'history_expired', ${EARLIER}, ${AT})`,
        [first.rows[0]?.id, workspace(f), mailbox(f)],
      );
    },
  },
  {
    constraint: 'mailbox_recoveries_mailbox_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
         VALUES ($1, $2, 1, 'history_expired', ${EARLIER}, ${AT})`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'mailbox_recoveries_hold_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at, hold_id)
         VALUES ($1, $2, 1, 'history_expired', ${EARLIER}, ${AT}, $3)`,
        [workspace(f), mailbox(f), MISSING],
      ),
  },
  {
    constraint: 'mailbox_recoveries_one_per_generation',
    run: async f => {
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
         VALUES ($1, $2, 1, 'history_expired', ${EARLIER}, ${AT})`,
        [workspace(f), mailbox(f)],
      );
      return await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
         VALUES ($1, $2, 1, 'baseline', ${EARLIER}, ${AT})`,
        [workspace(f), mailbox(f)],
      );
    },
  },
  {
    constraint: 'mailbox_recoveries_generation_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
         VALUES ($1, $2, 0, 'history_expired', ${EARLIER}, ${AT})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_recoveries_reason_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
         VALUES ($1, $2, 1, 'curiosity', ${EARLIER}, ${AT})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_recoveries_interval_ordered',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
         VALUES ($1, $2, 1, 'history_expired', ${AT}, ${EARLIER})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_recoveries_pages_not_negative',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at, pages_completed)
         VALUES ($1, $2, 1, 'history_expired', ${EARLIER}, ${AT}, -1)`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_recoveries_messages_not_negative',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at, messages_seen)
         VALUES ($1, $2, 1, 'history_expired', ${EARLIER}, ${AT}, -1)`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mailbox_recoveries_completed_not_before_started',
    run: async f =>
      await f.session.query(
        `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at,
                                         started_at, completed_at)
         VALUES ($1, $2, 1, 'history_expired', ${EARLIER}, ${AT}, ${LATER}, ${AT})`,
        [workspace(f), mailbox(f)],
      ),
  },

  // -------------------------------------------------- gmail_push_notifications
  {
    constraint: 'gmail_push_notifications_pkey',
    run: async f => {
      const first = await f.session.query<{ id: string }>(
        `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [workspace(f), mailbox(f), unique('push-')],
      );
      return await f.session.query(
        `INSERT INTO gmail_push_notifications (id, workspace_id, mailbox_id, provider_message_id)
         VALUES ($1, $2, $3, $4)`,
        [first.rows[0]?.id, workspace(f), mailbox(f), unique('push-')],
      );
    },
  },
  {
    constraint: 'gmail_push_notifications_mailbox_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id) VALUES ($1, $2, $3)`,
        [workspace(f), MISSING, unique('push-')],
      ),
  },
  {
    constraint: 'gmail_push_notifications_job_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id, job_id)
         VALUES ($1, $2, $3, $4)`,
        [workspace(f), mailbox(f), unique('push-'), MISSING],
      ),
  },
  {
    constraint: 'gmail_push_notifications_one_per_message',
    run: async f => {
      const id = unique('push-');
      await f.session.query(
        `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id) VALUES ($1, $2, $3)`,
        [workspace(f), mailbox(f), id],
      );
      return await f.session.query(
        `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id) VALUES ($1, $2, $3)`,
        [workspace(f), mailbox(f), id],
      );
    },
  },
  {
    constraint: 'gmail_push_notifications_message_id_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id) VALUES ($1, $2, '   ')`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'gmail_push_notifications_history_id_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO gmail_push_notifications (workspace_id, mailbox_id, provider_message_id, history_id)
         VALUES ($1, $2, $3, 'latest')`,
        [workspace(f), mailbox(f), unique('push-')],
      ),
  },

  // -------------------------------------------------------------- mail_messages
  {
    constraint: 'mail_messages_pkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (id, workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date)
         VALUES ($1, $2, $3, $4, 'thread01', 'incoming', ${AT})`,
        [message(f), workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_mailbox_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT})`,
        [workspace(f), MISSING, unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_one_per_provider_id',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT})`,
        [workspace(f), mailbox(f), f.mail.collidingProviderMessageId],
      ),
  },
  {
    constraint: 'mail_messages_one_per_rfc_id',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    rfc_message_id, direction, internal_date)
         VALUES ($1, $2, $3, 'thread01', $4, 'incoming', ${AT})`,
        [workspace(f), mailbox(f), unique('msg'), f.mail.collidingRfcMessageId],
      ),
  },
  {
    constraint: 'mail_messages_provider_id_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date)
         VALUES ($1, $2, 'not a gmail id', 'thread01', 'incoming', ${AT})`,
        [workspace(f), mailbox(f)],
      ),
  },
  {
    constraint: 'mail_messages_thread_id_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date)
         VALUES ($1, $2, $3, 'not a thread', 'incoming', ${AT})`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_rfc_id_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    rfc_message_id, direction, internal_date)
         VALUES ($1, $2, $3, 'thread01', '<bracketed@example.test>', 'incoming', ${AT})`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_direction_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date)
         VALUES ($1, $2, $3, 'thread01', 'sideways', ${AT})`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_from_canonical',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, header_from)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT}, 'Dana@Northwind.Example.Test')`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_subject_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, subject)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT}, repeat('s', 999))`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_in_reply_to_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, in_reply_to)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT}, '<earlier@example.test>')`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_auto_submitted_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, auto_submitted)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT}, repeat('a', 201))`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_list_id_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, list_id)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT}, repeat('l', 201))`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_references_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, reference_message_ids)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT},
                 (SELECT array_agg('ref' || n || '@example.test') FROM generate_series(1, 101) AS n))`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_recipients_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, header_to)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT},
                 (SELECT array_agg('to' || n || '@example.test') FROM generate_series(1, 201) AS n))`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_labels_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, label_ids)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT},
                 (SELECT array_agg('LABEL_' || n) FROM generate_series(1, 101) AS n))`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_attachments_are_array',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, attachment_references)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT}, '{"filename": "notes.txt"}'::jsonb)`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },
  {
    constraint: 'mail_messages_body_needs_match',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, metadata_only, matched)
         VALUES ($1, $2, $3, 'thread01', 'incoming', ${AT}, false, false)`,
        [workspace(f), mailbox(f), unique('msg')],
      ),
  },

  // -------------------------------------------------------- mail_message_bodies
  {
    constraint: 'mail_message_bodies_pkey',
    run: async f => {
      await f.session.query(
        'INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text) VALUES ($1, $2, $3)',
        [workspace(f), message(f), 'first'],
      );
      return await f.session.query(
        'INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text) VALUES ($1, $2, $3)',
        [workspace(f), message(f), 'second'],
      );
    },
  },
  {
    constraint: 'mail_message_bodies_message_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text) VALUES ($1, $2, $3)',
        [workspace(f), MISSING, 'orphan'],
      ),
  },
  {
    constraint: 'mail_message_bodies_text_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text)
         VALUES ($1, $2, repeat('x', 200001))`,
        [workspace(f), message(f)],
      ),
  },

  // ------------------------------------------------------- mail_message_matches
  {
    constraint: 'mail_message_matches_pkey',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (id, workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
         VALUES ($1, $2, $3, $4, $5, 'participant')`,
        [f.mail.alpha.matchId, workspace(f), message(f), other.firmId, other.opportunityId],
      );
    },
  },
  {
    constraint: 'mail_message_matches_message_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
         VALUES ($1, $2, $3, $4, 'participant')`,
        [workspace(f), MISSING, firm(f), opportunity(f)],
      ),
  },
  {
    constraint: 'mail_message_matches_opportunity_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
         VALUES ($1, $2, $3, $4, 'participant')`,
        [workspace(f), message(f), firm(f), MISSING],
      ),
  },
  {
    constraint: 'mail_message_matches_contact_fkey',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id,
                                           match_rule)
         VALUES ($1, $2, $3, $4, $5, 'participant')`,
        [workspace(f), message(f), other.firmId, other.opportunityId, contact(f)],
      );
    },
  },
  {
    constraint: 'mail_message_matches_hold_fkey',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule,
                                           ambiguous, hold_id)
         VALUES ($1, $2, $3, $4, 'participant', true, $5)`,
        [workspace(f), message(f), other.firmId, other.opportunityId, MISSING],
      );
    },
  },
  {
    constraint: 'mail_message_matches_resolver_fkey',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule,
                                           selected, resolved_at, resolved_by_user_id)
         VALUES ($1, $2, $3, $4, 'participant', false, ${AT}, $5)`,
        [workspace(f), message(f), other.firmId, other.opportunityId, otherWorkspaceUser(f)],
      );
    },
  },
  {
    constraint: 'mail_message_matches_one_per_opportunity',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
         VALUES ($1, $2, $3, $4, 'participant')`,
        [workspace(f), message(f), firm(f), opportunity(f)],
      ),
  },
  {
    constraint: 'mail_message_matches_one_selected',
    run: async f => {
      await f.session.query(
        `UPDATE mail_message_matches SET selected = true, resolved_at = ${AT} WHERE workspace_id = $1 AND id = $2`,
        [workspace(f), f.mail.alpha.matchId],
      );
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule,
                                           selected, resolved_at)
         VALUES ($1, $2, $3, $4, 'participant', true, ${AT})`,
        [workspace(f), message(f), other.firmId, other.opportunityId],
      );
    },
  },
  {
    constraint: 'mail_message_matches_rule_known',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
         VALUES ($1, $2, $3, $4, 'intuition')`,
        [workspace(f), message(f), other.firmId, other.opportunityId],
      );
    },
  },
  {
    constraint: 'mail_message_matches_ambiguous_has_hold',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule,
                                           ambiguous)
         VALUES ($1, $2, $3, $4, 'participant', true)`,
        [workspace(f), message(f), other.firmId, other.opportunityId],
      );
    },
  },
  {
    constraint: 'mail_message_matches_resolution_consistent',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule,
                                           selected)
         VALUES ($1, $2, $3, $4, 'participant', false)`,
        [workspace(f), message(f), other.firmId, other.opportunityId],
      );
    },
  },
  {
    constraint: 'mail_message_matches_resolver_resolved',
    run: async f => {
      const other = await anotherOpportunity(f);
      return await f.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule,
                                           resolved_by_user_id)
         VALUES ($1, $2, $3, $4, 'participant', $5)`,
        [workspace(f), message(f), other.firmId, other.opportunityId, salesperson(f)],
      );
    },
  },

  // ----------------------------------------------- mail_message_classifications
  {
    constraint: 'mail_message_classifications_pkey',
    run: async f => {
      const first = await f.session.query<{ id: string }>(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1') RETURNING id`,
        [workspace(f), message(f)],
      );
      return await f.session.query(
        `INSERT INTO mail_message_classifications (id, workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version, model_name, prompt_version)
         VALUES ($1, $2, $3, 'model', 'uncertain', true, 'reply.1', 'fixture-model', 'prompt.1')`,
        [first.rows[0]?.id, workspace(f), message(f)],
      );
    },
  },
  {
    constraint: 'mail_message_classifications_message_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1')`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'mail_message_classifications_one_per_layer',
    run: async f => {
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1')`,
        [workspace(f), message(f)],
      );
      return await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'automated', true, 'reply.1')`,
        [workspace(f), message(f)],
      );
    },
  },
  {
    constraint: 'mail_message_classifications_layer_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'vibes', 'uncertain', true, 'reply.1')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_class_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'annoyed', true, 'reply.1')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_disposition_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   suggested_disposition, requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'uncertain', 'maybe', true, 'reply.1')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_signals_are_array',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class, signals,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'uncertain', '{"rule": "x"}'::jsonb, true, 'reply.1')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_rules_version_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'deterministic', 'uncertain', true, 'Reply Rules v1')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_confidence_range',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version, model_name,
                                                   prompt_version, confidence)
         VALUES ($1, $2, 'model', 'uncertain', true, 'reply.1', 'fixture-model', 'prompt.1', 1.500)`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_model_fields_are_the_model_layer',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version, model_name)
         VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1', 'fixture-model')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_model_is_versioned',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version)
         VALUES ($1, $2, 'model', 'uncertain', true, 'reply.1')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_classifications_model_cannot_decide',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                   requires_confirmation, rules_version, model_name, prompt_version)
         VALUES ($1, $2, 'model', 'automated', true, 'reply.1', 'fixture-model', 'prompt.1')`,
        [workspace(f), message(f)],
      ),
  },

  // ------------------------------------------------------- mail_message_effects
  {
    constraint: 'mail_message_effects_pkey',
    run: async f => {
      const first = await f.session.query<{ id: string }>(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'no_effect', $3) RETURNING id`,
        [workspace(f), message(f), unique('target-')],
      );
      return await f.session.query(
        `INSERT INTO mail_message_effects (id, workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, $3, 'no_effect', $4)`,
        [first.rows[0]?.id, workspace(f), message(f), unique('target-')],
      );
    },
  },
  {
    constraint: 'mail_message_effects_message_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'no_effect', $3)`,
        [workspace(f), MISSING, unique('target-')],
      ),
  },
  {
    constraint: 'mail_message_effects_hold_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key, hold_id)
         VALUES ($1, $2, 'hold_opened', $3, $4)`,
        [workspace(f), message(f), unique('target-'), MISSING],
      ),
  },
  {
    constraint: 'mail_message_effects_suppression_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key,
                                           suppression_event_id)
         VALUES ($1, $2, 'handle_suppressed', $3, 'no-such-suppression-event')`,
        [workspace(f), message(f), unique('target-')],
      ),
  },
  {
    constraint: 'mail_message_effects_one_per_target',
    run: async f => {
      const target = unique('target-');
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'no_effect', $3)`,
        [workspace(f), message(f), target],
      );
      return await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'no_effect', $3)`,
        [workspace(f), message(f), target],
      );
    },
  },
  {
    constraint: 'mail_message_effects_kind_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'shrug', $3)`,
        [workspace(f), message(f), unique('target-')],
      ),
  },
  {
    constraint: 'mail_message_effects_target_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'no_effect', '   ')`,
        [workspace(f), message(f)],
      ),
  },
  {
    constraint: 'mail_message_effects_detail_is_object',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key, detail)
         VALUES ($1, $2, 'no_effect', $3, '[]'::jsonb)`,
        [workspace(f), message(f), unique('target-')],
      ),
  },
  {
    constraint: 'mail_message_effects_hold_named',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'hold_opened', $3)`,
        [workspace(f), message(f), unique('target-')],
      ),
  },
  {
    constraint: 'mail_message_effects_suppression_named',
    run: async f =>
      await f.session.query(
        `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key)
         VALUES ($1, $2, 'firm_suppressed', $3)`,
        [workspace(f), message(f), unique('target-')],
      ),
  },

  // ----------------------------------------------------------- template_versions
  {
    constraint: 'template_versions_pkey',
    run: async f => {
      const first = await f.session.query<{ id: string }>(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'First', 'Hello', $2, $3, 'Signed off', '1 Example Way')
         RETURNING id`,
        [workspace(f), BODY, HASH],
      );
      return await f.session.query(
        `INSERT INTO template_versions (id, workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, $2, gen_random_uuid(), 1, 'Second', 'Hello', $3, $4, 'Signed off', '1 Example Way')`,
        [first.rows[0]?.id, workspace(f), BODY, HASH],
      );
    },
  },
  {
    constraint: 'template_versions_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'Orphan', 'Hello', $2, $3, 'Signed off', '1 Example Way')`,
        [MISSING, BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_approver_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address, approved_at, approved_by_user_id)
         VALUES ($1, gen_random_uuid(), 1, 'Approved', 'Hello', $2, $3, 'Signed off', '1 Example Way', ${AT}, $4)`,
        [workspace(f), BODY, HASH, otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'template_versions_one_per_version',
    run: async f => {
      const templateId = (
        await f.session.query<{ id: string }>('SELECT gen_random_uuid() AS id')
      ).rows[0]?.id;
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, $2, 1, 'First', 'Hello', $3, $4, 'Signed off', '1 Example Way')`,
        [workspace(f), templateId, BODY, HASH],
      );
      return await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, $2, 1, 'Again', 'Hello', $3, $4, 'Signed off', '1 Example Way')`,
        [workspace(f), templateId, BODY, HASH],
      );
    },
  },
  {
    constraint: 'template_versions_version_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 0, 'Zero', 'Hello', $2, $3, 'Signed off', '1 Example Way')`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_name_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, '   ', 'Hello', $2, $3, 'Signed off', '1 Example Way')`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_subject_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'Long subject', repeat('s', 161), $2, $3, 'Signed off', '1 Example Way')`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_body_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'Long body', 'Hello', repeat('b', 4001), $2, 'Signed off', '1 Example Way')`,
        [workspace(f), HASH],
      ),
  },
  {
    constraint: 'template_versions_content_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'Bad hash', 'Hello', $2, 'not-a-digest', 'Signed off', '1 Example Way')`,
        [workspace(f), BODY],
      ),
  },
  {
    constraint: 'template_versions_sign_off_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'Blank sign-off', 'Hello', $2, $3, '   ', '1 Example Way')`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_postal_address_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'Blank address', 'Hello', $2, $3, 'Signed off', '   ')`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_variables_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address, required_variables)
         VALUES ($1, gen_random_uuid(), 1, 'Too many', 'Hello', $2, $3, 'Signed off', '1 Example Way',
                 (SELECT array_agg('variable' || n) FROM generate_series(1, 51) AS n))`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_approval_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address, approved_at)
         VALUES ($1, gen_random_uuid(), 1, 'Half approved', 'Hello', $2, $3, 'Signed off', '1 Example Way', ${AT})`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_no_unsubscribe_link',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address)
         VALUES ($1, gen_random_uuid(), 1, 'Web opt out', 'Hello',
                 'Hello.' || chr(10) || 'Click here to unsubscribe.', $2, 'Signed off', '1 Example Way')`,
        [workspace(f), HASH],
      ),
  },
  {
    constraint: 'template_versions_approved_has_stop_line',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address, approved_at, approved_by_user_id)
         VALUES ($1, gen_random_uuid(), 1, 'No stop line', 'Hello', 'Hello, no footer here.', $2,
                 'Signed off', '1 Example Way', ${AT}, $3)`,
        [workspace(f), HASH, admin(f)],
      ),
  },
  {
    constraint: 'template_versions_retired_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address, created_at, retired_at)
         VALUES ($1, gen_random_uuid(), 1, 'Backdated retirement', 'Hello', $2, $3, 'Signed off', '1 Example Way',
                 ${LATER}, ${EARLIER})`,
        [workspace(f), BODY, HASH],
      ),
  },
  {
    constraint: 'template_versions_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                        footer_sign_off, footer_postal_address, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), 1, 'Backdated update', 'Hello', $2, $3, 'Signed off', '1 Example Way',
                 ${LATER}, ${EARLIER})`,
        [workspace(f), BODY, HASH],
      ),
  },
];
