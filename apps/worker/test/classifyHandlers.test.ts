import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import type { SessionQueryable } from '@fss/domain/db';
import {
  HandlerRegistry,
  JOB_KIND_PROTECTION,
  jobIdempotencyKey,
  runTwiceUnderStolenLease,
} from '@fss/domain/jobs';
import {
  CLASSIFIER_PROMPT_VERSION,
  recordedAnthropicTransport,
  type RecordedAnswer,
} from '@fss/domain/classification';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import {
  CLASSIFY_JOB_KINDS,
  classifyHandlers,
  classifyReplySource,
  classifyWorkerOptions,
  describeClassifier,
  type ClassifyWorkerOptions,
} from '../src/handlers/classify.ts';

/**
 * The `classify.reply` handler under the real stolen-lease harness, and its due-work
 * source against a real database.
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

describe('the classify.reply handler and its scheduler source', () => {
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

  it('registers the kind Appendix C protects the way this handler says it does', () => {
    const handlers = classifyHandlers(options);
    expect(handlers.map(handler => handler.kind)).toEqual([...CLASSIFY_JOB_KINDS]);
    for (const handler of handlers) {
      expect(handler.protection, handler.kind).toBe(JOB_KIND_PROTECTION[handler.kind]);
    }
  });

  it('registers nothing when the deployment was given no API key', async () => {
    expect(classifyHandlers(undefined)).toEqual([]);
    expect(await classifyWorkerOptions({})).toBeUndefined();
    expect(describeClassifier(undefined)).toEqual({ classifier_configured: false, classifier_enabled: false });
  });

  it('reads FSS_CLASSIFIER=off without losing the key it was given', async () => {
    // A generated value: nothing in this repository is a credential.
    const key = randomBytes(24).toString('base64url');
    const off = await classifyWorkerOptions({ FSS_LLM_CLASSIFIER_API_KEY: key, FSS_CLASSIFIER: 'off' });
    expect(off?.processEnabled).toBe(false);
    const on = await classifyWorkerOptions({ FSS_LLM_CLASSIFIER_API_KEY: key });
    expect(on?.processEnabled).toBe(true);
    // The startup line says whether, never what.
    expect(JSON.stringify(describeClassifier(off))).not.toContain(key);
  });

  it('materializes one job per message whose second opinion is owed, and not a second', async () => {
    const source = classifyReplySource();
    const first = await runSchedulerPass(session, {
      sources: [source],
      now: new Date().toISOString(),
      instanceKey: 'classify-test',
    });
    expect(first.outcome).toBe('ran');
    expect(first.inserted).toBe(1);

    const { rows } = await session.query<{ idempotency_key: string; payload: Record<string, unknown> }>(
      "SELECT idempotency_key, payload FROM jobs WHERE workspace_id = $1 AND kind = 'classify.reply'",
      [workspaceId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.idempotency_key).toBe(jobIdempotencyKey.classifyReply(messageId));
    expect(rows[0]?.payload['messageId']).toBe(messageId);

    // A second pass over the same backlog inserts nothing: the key carries the
    // message and no instant, so `UNIQUE(workspace_id, kind, idempotency_key)` holds
    // for ever rather than for a minute.
    const second = await runSchedulerPass(session, {
      sources: [source],
      now: new Date().toISOString(),
      instanceKey: 'classify-test',
    });
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(1);

    await session.query("DELETE FROM jobs WHERE workspace_id = $1 AND kind = 'classify.reply'", [workspaceId]);
  });

  it('produces one model row under a stolen lease (Appendix G 2)', async () => {
    const countEffects = async (): Promise<number> => {
      const { rows } = await session.query<{ count: string }>(
        `SELECT count(*) AS count FROM mail_message_classifications
          WHERE workspace_id = $1 AND layer = 'model'`,
        [workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    };

    const report = await runTwiceUnderStolenLease({
      session,
      registry: registryFor(),
      run: runClaimedJob,
      workspaceId,
      kind: 'classify.reply',
      idempotencyKey: jobIdempotencyKey.classifyReply(messageId),
      payload: { messageId },
      countEffects,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
  });

  it('stops after it has an answer: the sweep does not re-ask a question with a row', async () => {
    // The model row now exists, so the pending read finds nothing and the pass
    // inserts nothing. A sweep that re-armed a finished classification would spend
    // money re-asking, which is the opposite of what the mail sources do and
    // deliberately so.
    const report = await runSchedulerPass(session, {
      sources: [classifyReplySource()],
      now: new Date().toISOString(),
      instanceKey: 'classify-test',
    });
    expect(report.inserted).toBe(0);
    expect(report.alreadyPresent).toBe(0);
  });
});
