import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import { recordedAnthropicTransport, type RecordedAnswer } from '@fss/domain/classification/recorded.ts';
import { CLASSIFIER_PROMPT_VERSION } from '@fss/domain/classification/types.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { classifyHandlers, classifyReplySource, type ClassifyWorkerOptions } from '../src/handlers/classify.ts';

/**
 * Slice P1, invariant I1: a `classify.reply` job that ran while the classifier was off
 * recorded `disabled` and completed. The reply is held, not answered: once the switch is
 * back on, the source owes it again under a key naming that turn-on, so it runs exactly
 * once; while the switch stays off nothing is re-armed.
 *
 * (The setup below is `classifyHandlers.test.ts`'s.)
 *
 * `docs/greenfield/jobs.md`: "A lane that registers a new handler adds a probe and
 * runs it. That is Appendix G scenario 2, and it is not optional." There is one new
 * handler, so there is one probe, and what it proves is what Appendix C means by
 * `business_uniqueness` for this kind: two workers racing produce one model row,
 * because `mail_message_classifications_one_per_layer` refuses the second and the
 * loser's whole transaction rolls back with its failed completion.
 *
 * Nothing in this file opens a socket. The transport is the recorded one and its
 * answers are three lines of synthetic JSON.
 */

const WORKSPACE_SLUG = 'alpha';
const OWNER_EMAIL = 'sales@example.test';
const ANSWER = JSON.stringify({
  class: 'human',
  disposition: 'interested',
  confidence: 0.8,
  supporting_excerpt: null,
  callback_proposal: null,
  model_version: 'claude-opus-5',
  prompt_version: CLASSIFIER_PROMPT_VERSION,
});

describe('a reply the classifier held while off is classified once it is back on (slice P1)', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let workspaceId: string;
  let messageId: string;
  let options: ClassifyWorkerOptions;

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;

    const workspace = await session.query<{ id: string }>(
      'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
      [WORKSPACE_SLUG, 'Alpha'],
    );
    workspaceId = workspace.rows[0]?.id ?? '';
    const user = await session.query<{ id: string }>(
      `INSERT INTO users (google_sub, email, display_name)
       VALUES ('classify-test-sub', $1, 'Sales Person') RETURNING id`,
      [OWNER_EMAIL],
    );
    const ownerUserId = user.rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, ownerUserId],
    );
    const mailbox = await session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, sync_state,
                              history_id, history_id_updated_at, baseline_from_at, baseline_completed_at,
                              coverage_watermark_at)
       VALUES ($1, $2, $3, 'gmail-account-1', 'ready', '1000', now(), now() - interval '30 days', now(), now())
       RETURNING id`,
      [workspaceId, ownerUserId, OWNER_EMAIL],
    );
    const mailboxId = mailbox.rows[0]?.id ?? '';

    const firm = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, 'Northgate Test Holdings', $2)
       RETURNING id`,
      [workspaceId, ownerUserId],
    );
    const firmId = firm.rows[0]?.id ?? '';
    const stage = await session.query<{ id: string }>(
      'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
      [workspaceId],
    );
    const opportunity = await session.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [workspaceId, firmId, stage.rows[0]?.id],
    );

    // An incoming, matched message the deterministic layer called `uncertain`: the
    // one state the sweep is looking for.
    const stored = await session.query<{ id: string }>(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                  direction, internal_date, header_from, header_to, subject, matched,
                                  metadata_only)
       VALUES ($1, $2, 'm-1', 'thread-m-1', 'incoming', now(), 'reception@northwind.example.test',
               ARRAY[$3]::text[], 'Re: hello', true, false)
       RETURNING id`,
      [workspaceId, mailboxId, OWNER_EMAIL],
    );
    messageId = stored.rows[0]?.id ?? '';
    await session.query(
      `INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text, truncated)
       VALUES ($1, $2, 'Tuesday works. Send an invite.', false)`,
      [workspaceId, messageId],
    );
    await session.query(
      `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
       VALUES ($1, $2, $3, $4, 'participant')`,
      [workspaceId, messageId, firmId, opportunity.rows[0]?.id],
    );
    await session.query(
      `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                 requires_confirmation, rules_version)
       VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1')`,
      [workspaceId, messageId],
    );

    const answers = new Map<string, RecordedAnswer>([['only', { text: ANSWER }]]);
    options = {
      transport: recordedAnthropicTransport({ answers, keyOf: () => 'only' }),
      processEnabled: true,
    };
  });

  afterAll(async () => {
    await database.drop();
  });

  const registryFor = (): HandlerRegistry => {
    const registry = new HandlerRegistry();
    for (const handler of classifyHandlers(options)) registry.register(handler);
    return registry;
  };

  const pass = async () =>
    await runSchedulerPass(session, { sources: [classifyReplySource()], now: new Date().toISOString(), instanceKey: 'classify-resume' });
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      const report = await runOnce(session, { registry: registryFor(), owner: 'classify-resume', limit: 5 });
      if (report.claimed === 0) return;
    }
  };
  const outcomes = async (): Promise<string[]> =>
    (
      await session.query<{ outcome: string }>(
        'SELECT outcome FROM mail_classification_calls WHERE workspace_id = $1 ORDER BY called_at',
        [workspaceId],
      )
    ).rows.map(row => row.outcome);
  const keys = async (): Promise<string[]> =>
    (
      await session.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM jobs WHERE workspace_id = $1 AND kind = 'classify.reply' ORDER BY created_at",
        [workspaceId],
      )
    ).rows.map(row => row.idempotency_key);

  it('off: the job records disabled; still off: nothing more; on: one request, then nothing', async () => {
    await session.query(
      `INSERT INTO classifier_settings (workspace_id, enabled, model_name, effort, max_output_tokens, daily_call_cap, updated_at)
       VALUES ($1, false, 'claude-opus-5', 'low', 512, 500, now() - interval '1 hour')`,
      [workspaceId],
    );
    expect((await pass()).inserted).toBe(1);
    await drain();
    expect(await outcomes()).toEqual(['disabled']);

    // Still off: the held reply is not re-armed, however many passes run.
    expect((await pass()).inserted).toBe(0);
    await drain();
    expect(await outcomes()).toEqual(['disabled']);

    // Back on: one new job, keyed by the turn-on, and one request.
    await session.query('UPDATE classifier_settings SET enabled = true, updated_at = now() WHERE workspace_id = $1', [workspaceId]);
    expect((await pass()).inserted).toBe(1);
    await drain();
    expect(await outcomes()).toEqual(['disabled', 'accepted']);
    const written = await keys();
    expect(written).toHaveLength(2);
    expect(written[0]).toBe(jobIdempotencyKey.classifyReply(messageId));
    expect(written[1]).toMatch(new RegExp(`^classify-reply:${messageId}:resume-\\d+$`));

    // Answered: never again.
    expect((await pass()).inserted).toBe(0);
  });
});
