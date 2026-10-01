import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession, createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { recordedAnthropicTransport, type RecordedAnswer } from '@fss/domain/classification/recorded.ts';
import type { AnthropicMessagesTransport } from '@fss/domain/classification/anthropicClient.ts';
import { updateClassifierSettings } from '@fss/domain/classification/settings.ts';
import { beginClassification, sweepClassificationReservations } from '@fss/domain/classification/classify.ts';
import { CLASSIFIER_PROMPT_VERSION } from '@fss/domain/classification/types.ts';
import { readSpend, workspaceBusinessZone } from '@fss/domain/research/ledger.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { classifyHandlers, classifyReplySource } from '../src/handlers/classify.ts';

/**
 * Slice P1, fix round 2: the reply classifier on the paid-call pattern, through the real
 * runner — `classify.reply` claimed, chunked and committed by `runOnce` — because the
 * defect this replaces (a charge the handler's rollback erased) is invisible to a test
 * that calls the classification function directly.
 *
 *   * paused while chunk 2 waits for the month → no request;
 *   * a provider error's estimate is committed, so the next reply sees less headroom, and
 *     a chunk 3 rolled back after a request still leaves the attempt charged;
 *   * two jobs for one reply → one request, concurrently and one after the other;
 *   * the lifetime cap: two paid attempts per reply, whatever is queued later.
 */

const ANSWER = JSON.stringify({
  class: 'human',
  disposition: 'interested',
  confidence: 0.8,
  supporting_excerpt: null,
  callback_proposal: null,
  model_version: 'claude-opus-5',
  prompt_version: CLASSIFIER_PROMPT_VERSION,
});

describe('classify.reply on the paid-call pattern (slice P1, fix round 2)', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let other: pg.Client;
  let otherSession: SessionQueryable;
  let workspaceId: string;
  let adminUserId: string;
  let mailboxId: string;
  let firmId: string;
  let opportunityId: string;
  let counter = 0;

  /** What the transport does next: answer, fail, or answer slowly. Counts every request. */
  let mode: 'answer' | 'fail' | 'malformed' | 'nousage' | 'reject_400' = 'answer';
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  let delayMs = 0;
  let requests = 0;
  /** Set by a test that watches the worker's statements: called when a request goes out. */
  let onRequest: (() => void) | null = null;
  const recorded = recordedAnthropicTransport({
    answers: new Map<string, RecordedAnswer>([
      ['answer', { text: ANSWER }],
      ['malformed', { text: 'not json at all' }],
      ['nousage', { text: ANSWER, noUsage: true }],
    ]),
    keyOf: () => (mode === 'malformed' ? 'malformed' : mode === 'nousage' ? 'nousage' : 'answer'),
  });
  const transport: AnthropicMessagesTransport = {
    countTokens: recorded.countTokens,
    create: async request => {
      requests += 1;
      onRequest?.();
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (mode === 'fail') throw new Error('socket hang up');
      if (mode === 'reject_400') {
        // The SDK's APIError shape: status, the parsed body.
        throw Object.assign(new Error('400 invalid_request_error'), {
          status: 400,
          // The canary: the reply's own words quoted back in the API's message (C3 review, finding 6).
          error: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format.schema: Invalid schema near "Tuesday works. Send an invite."' } },
        });
      }
      return await recorded.create(request);
    },
  };

  const admin = (db: SessionQueryable): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId: adminUserId, role: 'admin' }), db);
  const system = (): RepositoryContext => repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), session);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    workspaceId = (await session.query<{ id: string }>("INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id")).rows[0]?.id ?? '';
    const owner = (
      await session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('paid-owner', 'sales@example.test', 'Sales') RETURNING id",
      )
    ).rows[0]?.id ?? '';
    adminUserId = (
      await session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('paid-admin', 'admin@example.test', 'Admin') RETURNING id",
      )
    ).rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson'), ($1, $3, 'admin')",
      [workspaceId, owner, adminUserId],
    );
    mailboxId = (
      await session.query<{ id: string }>(
        `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, sync_state,
                                history_id, history_id_updated_at, baseline_from_at, baseline_completed_at, coverage_watermark_at)
         VALUES ($1, $2, 'sales@example.test', 'gmail-account-1', 'ready', '1000', now(), now() - interval '30 days', now(), now())
         RETURNING id`,
        [workspaceId, owner],
      )
    ).rows[0]?.id ?? '';
    firmId = (
      await session.query<{ id: string }>(
        "INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, 'Northgate Test Holdings', $2) RETURNING id",
        [workspaceId, owner],
      )
    ).rows[0]?.id ?? '';
    const stage = await session.query<{ id: string }>('SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1', [
      workspaceId,
    ]);
    opportunityId = (
      await session.query<{ id: string }>(
        'INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at) VALUES ($1, $2, $3, now()) RETURNING id',
        [workspaceId, firmId, stage.rows[0]?.id],
      )
    ).rows[0]?.id ?? '';
    await session.query(
      `INSERT INTO classifier_settings (workspace_id, enabled, model_name, effort, max_output_tokens, daily_call_cap, updated_at)
       VALUES ($1, true, 'claude-opus-5', 'low', 512, 500, now() - interval '1 hour')`,
      [workspaceId],
    );
    const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
    url.pathname = `/${database.name}`;
    other = new pg.Client({ connectionString: url.toString() });
    other.on('error', () => undefined);
    await other.connect();
    otherSession = asSession(other as unknown as Parameters<typeof asSession>[0]);
  });

  afterAll(async () => {
    await other?.end().catch(() => undefined);
    await database.drop();
  });

  /** One incoming, matched reply the deterministic layer called `uncertain`. Same words every time. */
  async function reply(): Promise<string> {
    counter += 1;
    const id = (
      await session.query<{ id: string }>(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction, internal_date,
                                    header_from, header_to, subject, matched, metadata_only)
         VALUES ($1, $2, $3, $4, 'incoming', now(), 'reception@northwind.example.test', ARRAY['sales@example.test']::text[],
                 'Re: hello', true, false)
         RETURNING id`,
        [workspaceId, mailboxId, `m-${String(counter)}`, `thread-${String(counter)}`],
      )
    ).rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text, truncated) VALUES ($1, $2, 'Tuesday works. Send an invite.', false)",
      [workspaceId, id],
    );
    await session.query(
      "INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule) VALUES ($1, $2, $3, $4, 'participant')",
      [workspaceId, id, firmId, opportunityId],
    );
    await session.query(
      `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class, requires_confirmation, rules_version)
       VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1')`,
      [workspaceId, id],
    );
    return id;
  }

  const registry = (): HandlerRegistry => {
    const built = new HandlerRegistry();
    for (const handler of classifyHandlers({ transport, processEnabled: true, log: (event, fields) => logs.push({ event, fields }) })) built.register(handler);
    return built;
  };
  async function enqueue(messageId: string, key: string): Promise<void> {
    await withTransaction(session, async () => {
      await enqueueJob(session, { workspaceId, kind: 'classify.reply', idempotencyKey: key, payload: { messageId }, maxAttempts: 2 });
    });
  }
  async function drain(on: SessionQueryable = session, limit = 5): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
      const report = await runOnce(on, { registry: registry(), owner: 'paid-test', limit });
      if (report.claimed === 0) return;
    }
  }
  async function attempts(messageId: string): Promise<{ attempt: number; state: string; cents: number; settled_cents: number }[]> {
    const { rows } = await session.query<{ attempt: number; state: string; cents: number; settled_cents: number }>(
      `SELECT attempt, state, cents, settled_cents FROM provider_reservations
        WHERE subject_kind = 'reply_classification' AND subject_id = $1 ORDER BY attempt`,
      [messageId],
    );
    return rows.map(row => ({ ...row, attempt: Number(row.attempt), cents: Number(row.cents), settled_cents: Number(row.settled_cents) }));
  }
  async function outcomes(messageId: string): Promise<string[]> {
    const { rows } = await session.query<{ outcome: string }>(
      'SELECT outcome FROM mail_classification_calls WHERE mail_message_id = $1 ORDER BY called_at, id',
      [messageId],
    );
    return rows.map(row => row.outcome);
  }
  const monthSpent = async (): Promise<number> => {
    const zone = await workspaceBusinessZone(system());
    return (await readSpend(system(), { businessTimeZone: zone, at: await databaseNow(system()) })).monthToDateCents;
  };
  async function ceiling(cents: number): Promise<void> {
    const saved = await withTransaction(session, async () =>
      await updateSetting(admin(session), { settingKey: 'monthly_cash_ceiling_cents', value: { cents } }),
    );
    if (!saved.ok) throw new Error(saved.reason);
  }
  async function classifier(enabled: boolean, db: SessionQueryable = session): Promise<void> {
    const saved = await withTransaction(db, async () => await updateClassifierSettings(admin(db), { enabled }));
    if (!saved.ok) throw new Error(saved.reason);
  }

  /** One reservation's cents for these words: every reply here is the same request. */
  let C = 0;

  it('the daily cap counts a pre-0031 request with no reservation and the new reservations together (P1 final round, #3)', async () => {
    // Run first, on an empty day: one request recorded before 0031 (no reservation), a cap
    // of 2, and two replies reserving before either has recorded a call.
    const legacy = await reply();
    await session.query(
      `INSERT INTO mail_classification_calls (workspace_id, mail_message_id, model_name, prompt_version, effort, request_sent,
                                              outcome, input_tokens, cached_input_tokens, output_tokens, latency_ms, business_date)
       SELECT $1, $2, 'claude-opus-5', $3, 'low', true, 'accepted', 10, 0, 10, 5, (now() AT TIME ZONE w.business_time_zone)::date
         FROM workspaces w WHERE w.id = $1`,
      [workspaceId, legacy, CLASSIFIER_PROMPT_VERSION],
    );
    await session.query('UPDATE classifier_settings SET daily_call_cap = 2 WHERE workspace_id = $1', [workspaceId]);
    const deps = { classifierFor: () => ({ classify: async () => await Promise.reject(new Error('not called')) }), processEnabled: true };
    try {
      const first = await reply();
      const second = await reply();
      const a = await withTransaction(session, async () => await beginClassification(system(), deps, { messageId: first, retry: false }));
      const b = await withTransaction(session, async () => await beginClassification(system(), deps, { messageId: second, retry: false }));
      expect(a.kind).toBe('reserved');
      expect(b).toMatchObject({ kind: 'done', report: { outcome: 'capped' } });
      // Gone again, so the rest of this file starts from an ordinary day with nothing owed.
      await session.query("DELETE FROM provider_reservations WHERE subject_kind = 'reply_classification' AND subject_id = $1", [first]);
      await session.query('DELETE FROM mail_message_classifications WHERE mail_message_id = ANY($1::uuid[])', [[legacy, first, second]]);
    } finally {
      await session.query('UPDATE classifier_settings SET daily_call_cap = 500 WHERE workspace_id = $1', [workspaceId]);
    }
  });

  it('the control: one request, settled at its cost, the model row written', async () => {
    mode = 'answer';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    const before = requests;
    await drain();
    expect(requests - before).toBe(1);
    const rows = await attempts(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('settled');
    C = rows[0]?.cents ?? 0;
    expect(C).toBeGreaterThan(0);
    expect(await outcomes(id)).toEqual(['accepted']);
  });

  it('nothing but BEGIN comes between chunk 2\'s commit and the request (P1 final round, #1)', async () => {
    mode = 'answer';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    const statements: string[] = [];
    const watching: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        statements.push(text.trim().split(/\s+/u).slice(0, 3).join(' '));
        return await session.query<Row>(text, values);
      },
    };
    let atRequest = -1;
    onRequest = () => {
      atRequest = statements.length;
    };
    try {
      for (let pass = 0; pass < 8; pass += 1) {
        const report = await runOnce(watching, { registry: registry(), owner: 'paid-test', limit: 5 });
        if (report.claimed === 0) break;
      }
    } finally {
      onRequest = null;
    }
    expect(atRequest).toBeGreaterThan(0);
    const before = statements.slice(0, atRequest);
    const lastCommit = before.lastIndexOf('COMMIT');
    expect(before.slice(lastCommit + 1)).toEqual(['BEGIN']);
  });

  it('paused while chunk 2 waits for the month: no request, released, recorded disabled, and owed again', async () => {
    mode = 'answer';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    // The worker's session, with the second monthly-lock acquisition (chunk 2's) held back
    // until the turn-off has committed on another connection.
    let monthly = 0;
    const pausing: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        if (typeof values?.[0] === 'string' && values[0].endsWith(':monthly_cash_ceiling') && text.includes('advisory_xact_lock')) {
          monthly += 1;
          if (monthly === 2) {
            await withTransaction(otherSession, async () => {
              await otherSession.query("SET LOCAL lock_timeout = '2s'");
              const saved = await updateClassifierSettings(admin(otherSession), { enabled: false });
              if (!saved.ok) throw new Error(saved.reason);
            }).catch(() => undefined);
          }
        }
        return await session.query<Row>(text, values);
      },
    };
    const before = requests;
    try {
      for (let pass = 0; pass < 8; pass += 1) {
        const report = await runOnce(pausing, { registry: registry(), owner: 'paid-test', limit: 5 });
        if (report.claimed === 0) break;
      }
      expect(monthly).toBeGreaterThanOrEqual(2);
      expect(requests - before).toBe(0);
      expect(await attempts(id)).toEqual([{ attempt: 1, state: 'released', cents: C, settled_cents: 0 }]);
      expect(await outcomes(id)).toEqual(['disabled']);
    } finally {
      await classifier(true);
    }
    // Back on: owed once, under a key naming the hold, and a second save owes nothing more.
    const owed = await classifyReplySource().find(session, new Date().toISOString());
    const mine = owed.filter(spec => spec.payload['messageId'] === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.idempotencyKey).toMatch(new RegExp(`^classify-reply:${id}:resume-\\d+$`));
    await classifier(true);
    const again = (await classifyReplySource().find(session, new Date().toISOString())).filter(spec => spec.payload['messageId'] === id);
    expect(again.map(spec => spec.idempotencyKey)).toEqual(mine.map(spec => spec.idempotencyKey));
    await runSchedulerPass(session, { sources: [classifyReplySource()], now: new Date().toISOString(), instanceKey: 'paid-test' });
    await drain();
    expect(requests - before).toBe(1);
    expect(await outcomes(id)).toEqual(['disabled', 'accepted']);
  });

  it('a provider error is charged, committed, and the next reply sees the smaller headroom', async () => {
    const spent = await monthSpent();
    // Room for two failed attempts of one reply and not one more attempt of another.
    await ceiling(spent + 3 * C - 1);
    try {
      mode = 'fail';
      const failing = await reply();
      await enqueue(failing, `classify-reply:${failing}`);
      const before = requests;
      await drain();
      // Each request's charge is committed with its chunk, whatever the job does next.
      expect(await attempts(failing)).toEqual([
        { attempt: 1, state: 'estimated', cents: C, settled_cents: C },
        { attempt: 2, state: 'estimated', cents: C, settled_cents: C },
      ]);
      expect(await monthSpent()).toBe(spent + 2 * C);
      expect(requests - before).toBe(2);
      mode = 'answer';
      const next = await reply();
      await enqueue(next, `classify-reply:${next}`);
      await drain();
      expect(requests - before).toBe(2);
      expect(await attempts(next)).toEqual([]);
      expect(await outcomes(next)).toEqual(['capped']);
    } finally {
      await ceiling(5000);
      mode = 'answer';
    }
  });

  it('a 400 invalid_request is refused before generation: one request, settled at 0, no retry, the API’s words in the log', async () => {
    mode = 'reject_400';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    const before = requests;
    const spent = await monthSpent();
    logs.length = 0;
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(requests - before).toBe(1);
    expect(await attempts(id)).toEqual([{ attempt: 1, state: 'settled', cents: C, settled_cents: 0 }]);
    expect(await monthSpent()).toBe(spent);
    expect(logs.find(line => line.event === 'classify_reply_provider_failed' && line.fields['mail_message_id'] === id)?.fields).toMatchObject({
      reason: 'provider_refused',
      will_retry: false,
      provider_status: 400,
      provider_error_type: 'invalid_request_error',
      provider_message: 'output_config.format.schema: Invalid schema near …',
    });
    // The recorded call stays `provider_error`: the CHECK constraint has no other word and this fix has no migration.
    expect(await outcomes(id)).toEqual(['provider_error']);
    expect(JSON.stringify(logs)).not.toContain('Tuesday');
  });

  it('an answer without usage is settled at its reservation, never at a computed zero (P1 final round, #2)', async () => {
    mode = 'nousage';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    const before = requests;
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(requests - before).toBe(1);
    expect(await attempts(id)).toEqual([{ attempt: 1, state: 'estimated', cents: C, settled_cents: C }]);
    expect(await outcomes(id)).toEqual(['accepted']);
  });

  it('a chunk 3 rolled back after its request leaves the attempt charged, and the sweep estimates it', async () => {
    mode = 'answer';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    const spent = await monthSpent();
    // The model row's insert fails after the request went out: the chunk rolls back.
    const breaking: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        if (text.includes('INSERT INTO mail_message_classifications') && values?.[1] === id) throw new Error('disk full');
        return await session.query<Row>(text, values);
      },
    };
    const before = requests;
    for (let pass = 0; pass < 8; pass += 1) {
      const report = await runOnce(breaking, { registry: registry(), owner: 'paid-test', limit: 5 });
      if (report.claimed === 0) break;
    }
    expect(requests - before).toBeGreaterThanOrEqual(1);
    const rows = await attempts(id);
    // Every request this reply made is charged: an open `calling` row is in the month's spend.
    expect(rows.filter(row => row.state === 'calling' || row.state === 'estimated').length).toBe(requests - before);
    expect(await monthSpent()).toBeGreaterThanOrEqual(spent + C);
    await session.query(
      "UPDATE provider_reservations SET created_at = now() - interval '31 minutes' WHERE subject_kind = 'reply_classification' AND subject_id = $1",
      [id],
    );
    await withTransaction(session, async () => await sweepClassificationReservations(system()));
    expect((await attempts(id)).every(row => row.state === 'estimated' && row.settled_cents === C)).toBe(true);
  });

  it('two jobs for one reply, run at once, make one request', async () => {
    mode = 'answer';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}:resume-1`);
    await enqueue(id, `classify-reply:${id}:resume-2`);
    delayMs = 300;
    const before = requests;
    try {
      // One job per claim, so each connection runs one of them, at the same time.
      await Promise.all([drain(session, 1), drain(otherSession, 1)]);
    } finally {
      delayMs = 0;
    }
    expect(requests - before).toBe(1);
    expect((await attempts(id)).map(row => row.state)).toEqual(['settled']);
  });

  it('a later job for a reply whose latest attempt was paid makes no request', async () => {
    mode = 'malformed';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    const before = requests;
    await drain();
    expect(requests - before).toBe(1);
    expect(await outcomes(id)).toEqual(['malformed']);
    mode = 'answer';
    await enqueue(id, `classify-reply:${id}:resume-9`);
    await drain();
    expect(requests - before).toBe(1);
  });

  it('the lifetime cap: two paid attempts for a reply, whatever is queued later', async () => {
    mode = 'fail';
    const id = await reply();
    await enqueue(id, `classify-reply:${id}`);
    const before = requests;
    try {
      await drain();
      expect(requests - before).toBe(2);
      await enqueue(id, `classify-reply:${id}:resume-x`);
      await drain();
      await classifier(true);
      expect((await classifyReplySource().find(session, new Date().toISOString())).filter(spec => spec.payload['messageId'] === id)).toEqual([]);
      expect(requests - before).toBe(2);
      expect((await attempts(id)).map(row => row.state)).toEqual(['estimated', 'estimated']);
    } finally {
      mode = 'answer';
    }
  });
});
