import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { WORKER_SCHEMA_RANGE } from '@fss/domain/db';
import {
  HandlerRegistry,
  canaryHandler,
  enqueueJob,
  raiseCriticalAlert,
  recordHeartbeat,
  recordingMetricSink,
} from '@fss/domain/jobs';
import { canarySource } from '../src/scheduler/sources.ts';
import { APPLICATION_RAISED_METRICS } from '../src/bootstrap/metricCoverage.ts';
import { readWorkerConfig } from '../src/bootstrap/config.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import { startWorker } from '../src/bootstrap/worker.ts';

/**
 * Every alarm in `infra/modules/alerts/main.tf` is over a metric somebody has to emit,
 * and an alarm over a metric nobody emits never fires.
 *
 * `packages/domain/test/jobs/observability.test.ts` already checks the *declaration*:
 * every name an alarm reads has an owner in `METRIC_OWNERS`. This file checks the
 * *emission*: it starts the real worker against a real database with the conditions
 * the alarms describe already true, and asserts the names that arrive at the sink.
 * What the worker does not publish must be named in `APPLICATION_RAISED_METRICS` with
 * the mechanism that raises it — a structured log event a CloudWatch metric filter
 * counts, another process, or a named later lane. Nothing may be uncovered.
 */

const ALERTS_TF = fileURLToPath(new URL('../../../infra/modules/alerts/main.tf', import.meta.url));

/**
 * The metric names inside `locals { alarms = { … } }`, parsed from the block rather
 * than from the whole file, so a metric named in a comment or in an output does not
 * silently satisfy the assertion.
 */
export function alarmMetricNames(terraform: string): Set<string> {
  const start = terraform.indexOf('alarms = {');
  if (start < 0) throw new Error('infra/modules/alerts/main.tf no longer declares local.alarms');
  let depth = 0;
  let end = start;
  for (let index = terraform.indexOf('{', start); index < terraform.length; index += 1) {
    const character = terraform[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const block = terraform.slice(start, end);
  const names = new Set<string>();
  for (const match of block.matchAll(/metric_name\s*=\s*"([A-Za-z0-9]+)"/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  if (names.size === 0) throw new Error('local.alarms named no metrics; the parser or the module changed');
  return names;
}

describe('every alarm metric has something that emits it', () => {
  let database: TestDatabase;
  let published: Set<string>;
  let alarms: Set<string>;

  beforeAll(async () => {
    alarms = alarmMetricNames(readFileSync(ALERTS_TF, 'utf8'));
    database = await createTestDatabase();

    const workspaces = await Promise.all(
      ['alpha', 'beta'].map(async slug => {
        const created = await database.session.query<{ id: string }>(
          'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
          [slug, `Workspace ${slug}`],
        );
        return created.rows[0]?.id ?? '';
      }),
    );

    // Make every condition the job metrics describe true before the worker starts.
    for (const workspaceId of workspaces) {
      // A runnable job nothing has a handler for: OldestRunnableJobAgeSeconds.
      await enqueueJob(database.session, {
        workspaceId,
        kind: 'research.firm',
        idempotencyKey: 'research-firm:shared:1',
        payload: {},
        maxAttempts: 4,
      });
      await raiseCriticalAlert(database.session, { workspaceId, alertKey: 'restore_generation_mismatch' });
    }
    // A dead job: DeadJobOldestAgeSeconds.
    await database.session.query(
      `INSERT INTO jobs (workspace_id, kind, idempotency_key, payload, state, dead_at, attempt_count, error_code)
       VALUES ($1, 'retention.batch', 'retention:messages:2026-09', '{}'::jsonb, 'dead', now(), 4, 'handler_failed')`,
      [workspaces[0] ?? ''],
    );
    // The API records its own heartbeat; the worker publishes it (ApiHeartbeat).
    await recordHeartbeat(database.session, { component: 'api', instanceKey: 'api-test' });

    // A connected mailbox with a live watch, so the mail lane's gauges have
    // something to report: GmailWatchHoursToExpiry and MailboxCheckHeartbeat. Both
    // are deliberately silent when there is no mailbox — the alarms treat missing
    // data as not breaching, and a deployment with no Gmail connected is not a
    // deployment whose watch is about to lapse.
    const mailWorkspace = workspaces[0] ?? '';
    const user = await database.session.query<{ id: string }>(
      `INSERT INTO users (google_sub, email, display_name)
       VALUES ('metric-coverage-sub', 'sales@example.test', 'Sales Person') RETURNING id`,
    );
    const ownerUserId = user.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [mailWorkspace, ownerUserId],
    );
    const mailbox = await database.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, sync_state,
                              baseline_from_at, baseline_completed_at)
       VALUES ($1, $2, 'sales@example.test', 'ready', now() - interval '30 days', now())
       RETURNING id`,
      [mailWorkspace, ownerUserId],
    );
    const mailboxId = mailbox.rows[0]?.id ?? '';
    await database.session.query(
      `INSERT INTO mailbox_watches (workspace_id, mailbox_id, generation, topic_name, expires_at)
       VALUES ($1, $2, 1, 'projects/callie-fss/topics/fss-test-gmail-push', now() + interval '6 days')`,
      [mailWorkspace, mailboxId],
    );
    await recordHeartbeat(database.session, {
      component: 'mailbox',
      workspaceId: mailWorkspace,
      instanceKey: mailboxId,
    });

    // A second mailbox that sent last week and has been disconnected since
    // yesterday: both halves of 13.3's `MailboxDisconnectedHours`, which is silent
    // without them and would otherwise alarm on a mailbox nobody has ever used.
    const departed = await database.session.query<{ id: string }>(
      `INSERT INTO users (google_sub, email, display_name)
       VALUES ('metric-coverage-departed', 'departed@example.test', 'Departed Person') RETURNING id`,
    );
    const departedUserId = departed.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [mailWorkspace, departedUserId],
    );
    const departedMailbox = await database.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, status, disconnected_at,
                              disconnect_reason)
       VALUES ($1, $2, 'departed@example.test', 'disconnected', now() - interval '3 days',
               'the grant was revoked')
       RETURNING id`,
      [mailWorkspace, departedUserId],
    );
    await database.session.query(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                  direction, internal_date)
       VALUES ($1, $2, 'departed-send-1', 'departed-thread-1', 'outgoing', now() - interval '7 days')`,
      [mailWorkspace, departedMailbox.rows[0]?.id ?? ''],
    );

    const sink = recordingMetricSink();
    const worker = await startWorker({
      config: readWorkerConfig({
        FSS_ROLE: 'worker',
        FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
        FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
        DATABASE_URL: 'postgresql://unused.invalid/fss',
        FSS_METRICS: 'off',
        FSS_SCHEDULER_INTERVAL_MS: '25',
        FSS_METRICS_INTERVAL_MS: '25',
        FSS_RUNNER_IDLE_MS: '10',
        FSS_WORKER_LIVENESS_FILE: join(tmpdir(), `${database.name}-liveness`),
      }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry().register(canaryHandler()),
      sources: [canarySource()],
      sink,
      log: recordingLogger(),
    });

    const deadline = Date.now() + 15_000;
    const wanted = [
      'CanaryCompletionAgeSeconds',
      'OldestRunnableJobAgeSeconds',
      'DeadJobOldestAgeSeconds',
      'GmailWatchHoursToExpiry',
      'MailboxDisconnectedHours',
    ];
    while (Date.now() < deadline && !wanted.every(name => sink.published.some(datum => datum.name === name))) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await worker.stop('test');
    published = new Set(sink.published.map(datum => datum.name));
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  it('publishes every job metric the alarms read', () => {
    for (const name of [
      'SchedulerHeartbeat',
      'WorkerHeartbeat',
      'ApiHeartbeat',
      'OldestRunnableJobAgeSeconds',
      'DeadJobOldestAgeSeconds',
      'CanaryCompletionAgeSeconds',
      'UnacknowledgedCriticalAlertAgeSeconds',
      'MailboxCheckHeartbeat',
      'GmailWatchHoursToExpiry',
      'MailboxDisconnectedHours',
    ]) {
      expect([...published].includes(name), `${name} was never published by the worker`).toBe(true);
    }
  });

  it('covers every alarm metric by emission or by a documented application mechanism', () => {
    const uncovered = [...alarms].filter(name => !published.has(name) && APPLICATION_RAISED_METRICS[name] === undefined);
    expect(uncovered, 'alarms over metrics nothing emits').toEqual([]);
  });

  it('documents nothing that is not an alarm metric', () => {
    const stale = Object.keys(APPLICATION_RAISED_METRICS).filter(name => !alarms.has(name));
    expect(stale, 'documented metrics no alarm reads').toEqual([]);
  });

  it('names the log event for every metric a CloudWatch metric filter derives', () => {
    for (const [name, entry] of Object.entries(APPLICATION_RAISED_METRICS)) {
      if (entry.raisedBy !== 'log_event') continue;
      expect(entry.detail, `${name} is log-derived but names no event`).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it('publishes no metric name an alarm does not read and no filter derives', () => {
    // A datum the alarms cannot read is a datum nobody sees. `validateMetricDatum`
    // refuses an unknown name already; this asserts the worker's own selection too.
    for (const name of published) {
      const known = alarms.has(name) || APPLICATION_RAISED_METRICS[name] !== undefined;
      expect(known, `${name} is published but no alarm reads it`).toBe(true);
    }
  });
});
