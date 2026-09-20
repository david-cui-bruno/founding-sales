import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, makeStepExecution, type TestDatabase } from '@fss/domain/db/testing';
import { repositoryContext, workspaceScope, type RepositoryContext, type SessionQueryable } from '@fss/domain/db';
import {
  HandlerRegistry,
  JOB_KIND_PROTECTION,
  claimJobs,
  enqueueJob,
  runTwiceUnderStolenLease,
} from '@fss/domain/jobs';
import {
  coalesceMailSync,
  localEnvelopeCipher,
  recordedGmailClient,
  recordingReplyPromoter,
  storeRefreshToken,
  type GmailFixture,
  type GmailOAuthConfig,
  type RecordedGmailClient,
} from '@fss/domain/mail';
import { recordingSuppressionJournal } from '@fss/domain/suppression';
import {
  beginReconciling,
  claimForDispatch,
  prepareOutboundMessage,
  renderedHash,
} from '@fss/domain/outbound';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
import { MAIL_JOB_KINDS, mailHandlers, todayReplyPromoter, type MailWorkerOptions } from '../src/handlers/mail.ts';
import { mailRecoverySource, mailSyncReconciliationSource, watchRenewalSource } from '../src/scheduler/mailSources.ts';

/**
 * The three mail handlers under the real stolen-lease harness, and the three mail
 * due-work sources against a real database.
 *
 * `docs/greenfield/jobs.md`: "A lane that registers a new handler adds a probe and
 * runs it. That is Appendix G scenario 2, and it is not optional." There are three
 * new handlers here, so there are three probes.
 *
 * What a probe proves for `mail.sync` is the sentence Appendix C means by
 * `business_uniqueness`: a worker whose lease was stolen rolls back its whole
 * transaction along with its failed completion, so the messages it imported go with
 * it and the mailbox ends with exactly one copy of each. The cursor is the same story
 * told by the compare-and-set.
 *
 * Every Gmail call in this file is the recorded fixture. Nothing opens a socket.
 */

const NOW = '2026-09-21T14:00:00.000Z';
const HOSTED_DOMAIN = 'example.test';

describe('the mail handlers and scheduler sources', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let workspaceId: string;
  let ownerUserId: string;
  let mailboxId: string;
  let context: RepositoryContext;
  let options: MailWorkerOptions;
  let fixture: GmailFixture;
  let gmail: RecordedGmailClient;
  const cipher = localEnvelopeCipher('worker-test-envelope');
  const refreshToken = randomBytes(24).toString('base64url');

  const oauth = (): GmailOAuthConfig => ({
    clientId: 'worker-test.apps.googleusercontent.test',
    clientSecret: randomBytes(24).toString('base64url'),
    redirectUri: 'https://api.example.test/oauth/gmail/callback',
    authorizationEndpoint: 'https://accounts.example.test/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.example.test/token',
    revocationEndpoint: 'https://oauth2.example.test/revoke',
    apiBaseUrl: 'https://gmail.example.test',
  });

  const message = (id: string, historyId: string): GmailFixture['messages'][number] => ({
    id,
    threadId: `thread-${id}`,
    internalDateEpochMilliseconds: Date.parse(NOW) - 60_000,
    labelIds: ['INBOX'],
    historyId,
    headers: {
      'Message-ID': `<${id}@example.test>`,
      From: `Reply Sender <reply-${id}@example.test>`,
      To: `sales@${HOSTED_DOMAIN}`,
      Subject: 'Re: your note',
      Date: NOW,
    },
    body: 'Thanks for reaching out. Let us set up a call next week.',
  });

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;

    const workspace = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';

    const user = await session.query<{ id: string }>(
      `INSERT INTO users (google_sub, email, display_name)
       VALUES ('worker-test-sub', 'sales@${HOSTED_DOMAIN}', 'Sales Person') RETURNING id`,
    );
    ownerUserId = user.rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, ownerUserId],
    );

    // A mailbox whose baseline is behind it, which is what `sync_state = 'ready'`
    // means and what the reconciliation sweep looks for.
    const mailbox = await session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id,
                              sync_state, history_id, history_id_updated_at,
                              baseline_from_at, baseline_completed_at, coverage_watermark_at, last_synced_at)
       VALUES ($1, $2, $3, 'gmail-account-1', 'ready', '1000', now(), now() - interval '30 days',
               now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour')
       RETURNING id`,
      [workspaceId, ownerUserId, `sales@${HOSTED_DOMAIN}`],
    );
    mailboxId = mailbox.rows[0]?.id ?? '';

    context = repositoryContext(
      workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
      session,
    );
    await storeRefreshToken(context, { mailboxId, plaintext: refreshToken, cipher });

    fixture = {
      emailAddress: `sales@${HOSTED_DOMAIN}`,
      historyId: '1010',
      refreshToken,
      messages: [message('m-1', '1005'), message('m-2', '1008')],
    };

    // `indeterminate_but_delivered` is Appendix B's nastiest row: Gmail accepted the
    // message and the response was lost. The fixture puts it in the Sent folder and
    // still reports that nobody knows, which is what makes the reconciliation probe
    // a real one rather than a search for something that was never sent.
    gmail = recordedGmailClient({ ...fixture, sendBehaviour: 'indeterminate_but_delivered' });
    options = {
      gmail,
      oauth: oauth(),
      cipher,
      journal: recordingSuppressionJournal(),
      replyPromoter: recordingReplyPromoter(),
      pushTopicName: 'projects/callie-fss/topics/fss-test-gmail-push',
    };
  });

  afterAll(async () => {
    await database.drop();
  });

  const registryFor = (): HandlerRegistry => {
    const registry = new HandlerRegistry();
    for (const handler of mailHandlers(options)) registry.register(handler);
    return registry;
  };

  /**
   * Put a job row into a terminal state the way the runner does.
   *
   * `jobs_lease_consistent`, `jobs_completed_at_consistent` and `jobs_dead_at_consistent`
   * make a half-finished row impossible, so a test that wants a finished one has to
   * finish it properly rather than setting `state` and walking away.
   */
  const settleJobs = async (kind: string, state: 'done' | 'dead'): Promise<void> => {
    await session.query(
      `UPDATE jobs
          SET state = $2,
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END,
              dead_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END,
              updated_at = now()
        WHERE workspace_id = $1 AND kind = $3`,
      [workspaceId, state, kind],
    );
  };

  const countMessages = async (): Promise<number> => {
    const { rows } = await session.query<{ count: string }>(
      'SELECT count(*) AS count FROM mail_messages WHERE workspace_id = $1',
      [workspaceId],
    );
    return Number(rows[0]?.count ?? '0');
  };

  // ------------------------------------------------------- the reply lane adapter
  it('promotes a reply on the caller\'s transaction, so a rollback takes the item with it', async () => {
    const firm = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, region_code, postal_code)
       VALUES ($1, 'Northgate Residential Management', 'TX', '79901') RETURNING id`,
      [workspaceId],
    );
    const firmId = firm.rows[0]?.id ?? '';
    const messageId = randomUUID();

    // Appendix A puts the today item in the *same* transaction as the message, its
    // candidates and their holds. An adapter that opened its own connection would
    // type-check and quietly break that, so the test rolls back and looks.
    await session.query('BEGIN');
    await todayReplyPromoter().promoteReply(context, { firmId, messageId, receivedAt: NOW });
    const inside = await session.query<{ kind: string }>(
      'SELECT kind FROM today_items WHERE workspace_id = $1 AND item_key = $2',
      [workspaceId, `reply-message:${messageId}`],
    );
    expect(inside.rows.map(row => row.kind)).toEqual(['reply']);
    await session.query('ROLLBACK');

    const after = await session.query<{ count: string }>(
      'SELECT count(*) AS count FROM today_items WHERE workspace_id = $1 AND item_key = $2',
      [workspaceId, `reply-message:${messageId}`],
    );
    expect(after.rows[0]?.count).toBe('0');
  });

  // ------------------------------------------------------------- registration
  it('declares the protection Appendix C gives each kind, or the registry refuses it', () => {
    const handlers = mailHandlers(options);
    expect(handlers.map(handler => handler.kind).sort()).toEqual([...MAIL_JOB_KINDS].sort());
    for (const handler of handlers) {
      expect(handler.protection, handler.kind).toBe(JOB_KIND_PROTECTION[handler.kind]);
    }
    // Registering is where a disagreement with Appendix C is caught.
    expect(() => registryFor()).not.toThrow();
  });

  it('registers nothing in a process that was given no Gmail configuration', () => {
    expect(mailHandlers(undefined)).toEqual([]);
  });

  /**
   * A fence sitting in `reconciling` with its message already in the Sent folder.
   *
   * Built through the real transitions rather than by INSERT, because the state
   * machine's trigger refuses anything else — which is the point of it.
   */
  const reconcilingFence = async (): Promise<string> => {
    const firm = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, region_code, postal_code)
       VALUES ($1, $2, 'TX', '79901') RETURNING id`,
      [workspaceId, `Fence Firm ${randomUUID().slice(0, 8)}`],
    );
    const firmId = firm.rows[0]?.id ?? '';
    const body =
      'Hello.\n\nSigned off\n1 Example Way\nReply "stop" and I will not email you again.';
    const subject = 'A short note';
    const templateId = randomUUID();
    const contentHash = renderedHash(`template:${templateId}`, body);
    const template = await session.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, footer_postal_address,
                                      approved_at, approved_by_user_id)
       VALUES ($1, $2, 1, 'Probe template', $3, $4, $5, 'Signed off', '1 Example Way', now(), $6)
       RETURNING id`,
      [workspaceId, templateId, subject, body, contentHash, ownerUserId],
    );

    // Migration 0012's `outbound_messages_step_execution_fkey`: the fence names a
    // step execution that exists, so the probe makes one rather than an id.
    const stepExecutionId = await makeStepExecution(session, {
      workspaceId,
      firmId,
      userId: ownerUserId,
      templateVersionId: template.rows[0]?.id ?? '',
    });

    const prepared = await prepareOutboundMessage(context, {
      stepExecutionId,
      firmId,
      ownerUserId,
      templateVersionId: template.rows[0]?.id ?? '',
      templateContentHash: contentHash,
      toAddress: 'probe.prospect@example.test',
      subject,
      body,
      sendAt: NOW,
      sourceZone: 'UTC',
      businessDate: NOW.slice(0, 10),
    });
    if (!prepared.ok) throw new Error(`the probe could not prepare a fence: ${prepared.reason}`);
    const fenceId = prepared.value.outboundMessageId;

    // Dispatch by hand: claim, put the message in the fixture's Sent folder, and
    // leave the fence in doubt. That is Appendix B's "Gmail success but database
    // update failed", which is exactly the state a reconciliation exists for.
    const claim = await claimForDispatch(context, { outboundMessageId: fenceId, actor: 'probe' });
    if (!claim.ok) throw new Error('the probe could not claim the fence');
    const fence = await session.query<{ provider_message_id_header: string }>(
      'SELECT provider_message_id_header FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId, fenceId],
    );
    await options.gmail.sendMessage(
      { accessToken: 'probe', expiresAtEpochSeconds: 0 },
      {
        to: 'probe.prospect@example.test',
        from: `sales@${HOSTED_DOMAIN}`,
        subject,
        body,
        rfcMessageId: fence.rows[0]?.provider_message_id_header ?? '',
      },
    );
    await beginReconciling(context, {
      outboundMessageId: fenceId,
      detail: 'the probe left it in doubt',
      windowHours: 24,
      actor: 'probe',
    });
    return fenceId;
  };

  // -------------------------------------------------- Appendix G scenario 2
  it('imports each message once under a stolen lease, not twice', async () => {
    const report = await runTwiceUnderStolenLease({
      session,
      registry: registryFor(),
      run: runClaimedJob,
      workspaceId,
      kind: 'mail.sync',
      idempotencyKey: `mail-sync:${mailboxId}`,
      payload: { mailboxId, historyId: '1010' },
      countEffects: countMessages,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    // Two fixture messages, imported once between them.
    expect(report.effectsAfter - report.effectsBefore).toBe(2);
    expect(BigInt(report.freshFencingToken)).toBeGreaterThan(BigInt(report.staleFencingToken));
  });

  it('records one recovery page under a stolen lease, not two', async () => {
    await session.query(
      `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
       VALUES ($1, $2, 1, 'baseline', now() - interval '30 days', now())`,
      [workspaceId, mailboxId],
    );
    const countPages = async (): Promise<number> => {
      const { rows } = await session.query<{ pages: number | null }>(
        'SELECT sum(pages_completed)::integer AS pages FROM mailbox_recoveries WHERE workspace_id = $1',
        [workspaceId],
      );
      return rows[0]?.pages ?? 0;
    };

    const report = await runTwiceUnderStolenLease({
      session,
      registry: registryFor(),
      run: runClaimedJob,
      workspaceId,
      kind: 'mail.recover',
      idempotencyKey: `mail-recover:${mailboxId}:1`,
      payload: { mailboxId, generation: 1 },
      countEffects: countPages,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
  });

  it('registers one watch under a stolen lease, not two', async () => {
    const countWatches = async (): Promise<number> => {
      const { rows } = await session.query<{ count: string }>(
        'SELECT count(*) AS count FROM mailbox_watches WHERE workspace_id = $1',
        [workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    };

    const report = await runTwiceUnderStolenLease({
      session,
      registry: registryFor(),
      run: runClaimedJob,
      workspaceId,
      kind: 'mail.watch_renew',
      idempotencyKey: `watch:${mailboxId}:1`,
      payload: { mailboxId, generation: 1 },
      countEffects: countWatches,
    });

    expect(report.freshOutcome).toBe('completed');
    // `fencing_token` protection: the stale worker's write is refused by the lock on
    // its own job row rather than by a unique index, and the count is still one.
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
  });

  it('settles a reconciling fence once under a stolen lease, and never sends', async () => {
    const fenceId = await reconcilingFence();
    const sendsBefore = gmail.sends.length;
    const countSettled = async (): Promise<number> => {
      const { rows } = await session.query<{ count: string }>(
        "SELECT count(*) AS count FROM outbound_messages WHERE workspace_id = $1 AND state = 'sent'",
        [workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    };

    const report = await runTwiceUnderStolenLease({
      session,
      registry: registryFor(),
      run: runClaimedJob,
      workspaceId,
      kind: 'mail.reconcile',
      idempotencyKey: `mail-reconcile:${mailboxId}:2026-09-21T14:00Z`,
      payload: { mailboxId },
      countEffects: countSettled,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    // The strongest assertion in this file: a reconciliation observes. However many
    // workers ran it, and whatever happened to their leases, nothing was sent.
    expect(gmail.sends.length).toBe(sendsBefore);
    expect(await readFenceState(fenceId)).toBe('sent');
  });

  const readFenceState = async (fenceId: string): Promise<string> => {
    const { rows } = await session.query<{ state: string }>(
      'SELECT state FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId, fenceId],
    );
    return rows[0]?.state ?? 'absent';
  };

  // ----------------------------------------------------------- payload shape
  it('fails a payload it cannot validate rather than running against a row it invented', async () => {
    const registry = registryFor();
    const cases: { kind: string; payload: Record<string, unknown> }[] = [
      { kind: 'mail.sync', payload: {} },
      { kind: 'mail.recover', payload: { mailboxId } },
      { kind: 'mail.recover', payload: { mailboxId, generation: 0 } },
      { kind: 'mail.watch_renew', payload: { mailboxId, generation: 'next' } },
    ];
    for (const [index, entry] of cases.entries()) {
      await enqueueJob(session, {
        workspaceId,
        kind: entry.kind,
        idempotencyKey: `mail-invalid:${String(index)}`,
        payload: entry.payload,
      });
    }
    const claims = await claimJobs(session, {
      owner: 'payload-worker',
      kinds: ['mail.sync', 'mail.recover', 'mail.watch_renew'],
      limit: 10,
      leaseSeconds: 30,
    });
    const invalid = claims.filter(job => job.idempotencyKey.startsWith('mail-invalid:'));
    expect(invalid).toHaveLength(4);
    for (const job of invalid) {
      expect(await runClaimedJob(session, { registry, job }), JSON.stringify(job.payload)).toBe('retryable');
    }
  });

  // ------------------------------------------------------- the due-work sources
  it('the reconciliation sweep coalesces a sync for a mailbox that has gone quiet', async () => {
    await settleJobs('mail.sync', 'done');
    // Relative to the pass's instant, not the database's: the sweep compares
    // `last_synced_at` with the `now` the scheduler pass was given.
    await session.query(
      "UPDATE mailboxes SET last_synced_at = $2::timestamptz - interval '1 hour' WHERE id = $1",
      [mailboxId, NOW],
    );

    const specifications = await mailSyncReconciliationSource(5).find(session, NOW);
    // The source does its own upsert, because `mail-sync:{mailbox}` carries no
    // instant and `ON CONFLICT DO NOTHING` cannot re-arm a finished row.
    expect(specifications).toEqual([]);

    const { rows } = await session.query<{ state: string }>(
      "SELECT state FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, `mail-sync:${mailboxId}`],
    );
    expect(rows.map(row => row.state)).toEqual(['queued']);
  });

  it('the reconciliation sweep leaves a freshly synced mailbox alone', async () => {
    await settleJobs('mail.sync', 'done');
    await session.query('UPDATE mailboxes SET last_synced_at = $2::timestamptz WHERE id = $1', [mailboxId, NOW]);
    await mailSyncReconciliationSource(5).find(session, NOW);
    const { rows } = await session.query<{ state: string }>(
      "SELECT state FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, `mail-sync:${mailboxId}`],
    );
    expect(rows.map(row => row.state)).toEqual(['done']);
  });

  it('13.2: the reconciliation sweep never revives a dead sync', async () => {
    await settleJobs('mail.sync', 'dead');
    await session.query(
      "UPDATE mailboxes SET last_synced_at = $2::timestamptz - interval '1 hour' WHERE id = $1",
      [mailboxId, NOW],
    );
    await mailSyncReconciliationSource(5).find(session, NOW);
    const { rows } = await session.query<{ state: string }>(
      "SELECT state FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, `mail-sync:${mailboxId}`],
    );
    expect(rows.map(row => row.state)).toEqual(['dead']);
  });

  it('the recovery source re-arms an incomplete recovery and stops when it completes', async () => {
    await settleJobs('mail.recover', 'done');
    await session.query('UPDATE mailbox_recoveries SET completed_at = NULL WHERE workspace_id = $1', [workspaceId]);

    await mailRecoverySource().find(session, NOW);
    const armed = await session.query<{ state: string }>(
      "SELECT state FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, `mail-recover:${mailboxId}:1`],
    );
    expect(armed.rows.map(row => row.state)).toEqual(['queued']);

    await session.query('UPDATE mailbox_recoveries SET completed_at = now() WHERE workspace_id = $1', [workspaceId]);
    await settleJobs('mail.recover', 'done');
    await mailRecoverySource().find(session, NOW);
    const settled = await session.query<{ state: string }>(
      "SELECT state FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, `mail-recover:${mailboxId}:1`],
    );
    expect(settled.rows.map(row => row.state)).toEqual(['done']);
  });

  it('the watch source composes the next generation, so a repeated pass inserts nothing twice', async () => {
    await session.query(
      `UPDATE mailbox_watches SET cancelled_at = greatest(now(), registered_at),
                                  cancelled_reason = 'the test wants the next generation'
        WHERE workspace_id = $1 AND cancelled_at IS NULL`,
      [workspaceId],
    );

    const first = await watchRenewalSource().find(session, NOW);
    expect(first).toHaveLength(1);
    const specification = first[0];
    if (specification === undefined) throw new Error('the watch source found nothing');
    expect(specification.kind).toBe('mail.watch_renew');
    // `mailbox_watches.generation` counts renewals and is independent of
    // `mailboxes.generation`, so the key is new every time round.
    expect(specification.idempotencyKey).toBe(`watch:${mailboxId}:2`);

    const second = await watchRenewalSource().find(session, NOW);
    expect(second[0]?.idempotencyKey).toBe(specification.idempotencyKey);
  });

  it('no source reaches anything but PostgreSQL, which is what 13.1 requires of the pass', async () => {
    const before = gmail.calls.length;
    await mailRecoverySource().find(session, NOW);
    await mailSyncReconciliationSource(5).find(session, NOW);
    await watchRenewalSource().find(session, NOW);
    expect(gmail.calls.length).toBe(before);
  });

  it('a coalesced sync merges rather than duplicating while one is in flight', async () => {
    await settleJobs('mail.sync', 'done');
    const first = await coalesceMailSync(session, { workspaceId, mailboxId, historyId: '1100' });
    const second = await coalesceMailSync(session, { workspaceId, mailboxId, historyId: '1099' });
    expect(second.jobId).toBe(first.jobId);
    expect(second.outcome).toBe('merged');
    // Never lowered by a late notification.
    expect(second.historyId).toBe('1100');
  });
});
