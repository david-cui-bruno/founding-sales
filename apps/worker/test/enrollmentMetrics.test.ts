import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { WORKER_SCHEMA_RANGE } from '@fss/domain/db/schemaRange.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { SENDING_STOP_LINE, templateContentHash } from '@fss/domain/src/rules/templates.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { recordingMetricSink, type MetricDatum } from '@fss/domain/jobs/metrics.ts';
import { localEnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { openHold } from '@fss/domain/policy/holds.ts';
import { ALL_BLOCKED_ACTION_KINDS } from '@fss/domain/policy/types.ts';
import { readWorkerConfig } from '../src/bootstrap/config.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import { startWorker } from '../src/bootstrap/worker.ts';
import { outboundSendHandoff } from '../src/handlers/outboundSendHandoff.ts';
import { sequenceActionJobHandler, sequenceActionSource } from '../src/handlers/sequenceAction.ts';
import type { DueWorkSource } from '../src/scheduler/schedulerPass.ts';

/**
 * `ActiveEnrollments` and `HeldEnrollments` through the real worker (specification
 * 4.2, 13.3, 16.2; lane g72).
 *
 * The domain tests decide the semantics hold by hold. This file proves the chain the
 * `all_sequences_held` alarm depends on, in production's shape today — sending
 * switched off by the deployment:
 *
 *   1. with nothing enrolled the metric loop publishes 0 and 0 on every pass, so the
 *      alarm's `IF(active > 0, held / active, 0)` is 0 and the alarm is OK rather than
 *      INSUFFICIENT_DATA;
 *   2. two enrollments with an email step due are picked up by the scheduler pass, run
 *      by the real `sequence.action` handler, prepared as real fences and refused by
 *      the real send gate because `deploymentSendingEnabled` is false. Each step is
 *      held `scoped_pause` and no hold row is opened — and the gauges read 2 active,
 *      0 held, because sending that nobody has enabled is not an unexpected hold;
 *   3. a workspace-scope hold nobody chose (here `mailbox_disconnected`) is then opened,
 *      and the gauges read 2 and 2: every live enrollment held, which is the alarm's case.
 *
 * The worker runs on a fixed clock, Monday 21 September 2026 at 10:00 New York, after
 * the steps' due instant (Friday 18 September, 09:00 New York, inside the firm's
 * window). The gauges read no clock; the scheduler pass does, and a pass on the real
 * clock would still find the steps due, so the clock here is what makes the pass
 * deterministic rather than what makes the gauges pass.
 *
 * Fictional throughout: `example.test` addresses, NANP-free, and no real name.
 */

const AT = '2026-09-21T14:00:00.000Z';
const DUE = '2026-09-18T13:00:00.000Z';

describe('the worker publishes ActiveEnrollments and HeldEnrollments on every pass', () => {
  let database: TestDatabase;
  let workspaceId = '';
  let userId = '';
  let versionId = '';
  let stepId = '';
  const prospects: { firmId: string; contactId: string; opportunityId: string }[] = [];

  const one = async (sql: string, values: readonly unknown[] = []): Promise<string> => {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 50)}`);
    return id;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaceId = await one(
      "INSERT INTO workspaces (slug, display_name, business_time_zone) VALUES ('alpha', 'Alpha Test', 'America/New_York') RETURNING id",
    );
    userId = await one(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-g72', 'sales@example.test', 'Sales Person') RETURNING id",
    );
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, userId],
    );
    // A connected mailbox with proved coverage, so eligibility and the gate get as far
    // as the sending switch and it is the switch, not the mailbox, that holds the step.
    // Proved means a fresh watermark, not `ready` alone (lane g77, mail/coverage.ts).
    await database.session.query(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, sync_state,
                              baseline_from_at, baseline_completed_at, history_id, history_id_updated_at,
                              coverage_watermark_at)
       VALUES ($1, $2, 'sales@example.test', 'ready', now() - interval '30 days', now(), '1', now(), now())`,
      [workspaceId, userId],
    );

    const stageId = await one('SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1', [
      workspaceId,
    ]);
    for (const label of ['northwind', 'southwind']) {
      const firmId = await one(
        `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, postal_code,
                            time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
         VALUES ($1, $2, $3, 'RI', '02903', 'America/New_York', 'high', 'postal', 'firm-zone.1')
         RETURNING id`,
        [workspaceId, `${label} Test Holdings`, userId],
      );
      const contactId = await one(
        "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Dana Example') RETURNING id",
        [workspaceId, firmId],
      );
      await database.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                      association_confidence, technical_validation, eligibility,
                                      eligibility_policy_version)
         VALUES ($1, $2, $3, $4, 'salesperson', now(), 0.950, 'passed', 'usable', 'route-policy.1')`,
        [workspaceId, firmId, contactId, `dana@${label}.example.test`],
      );
      const opportunityId = await one(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
         VALUES ($1, $2, $3, now()) RETURNING id`,
        [workspaceId, firmId, stageId],
      );
      prospects.push({ firmId, contactId, opportunityId });
    }

    const templateId = await one('SELECT gen_random_uuid() AS id');
    const subject = 'A question about {firm_name}';
    const body = `Hello,\n\nA note.\n\nSam Example\n${SENDING_STOP_LINE}`;
    const templateVersionId = await one(
      `INSERT INTO template_versions
         (workspace_id, template_id, version, name, subject, body, content_hash,
          footer_sign_off, required_variables, approved_at, approved_by_user_id)
       VALUES ($1, $2, 1, 'First touch', $3, $4, $5, 'Sam Example', ARRAY['firm_name'], now(), $6)
       RETURNING id`,
      [workspaceId, templateId, subject, body, templateContentHash({ templateId, version: 1, subject, body }), userId],
    );
    const sequenceId = await one(
      "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'Outreach', $2) RETURNING id",
      [workspaceId, userId],
    );
    versionId = await one(
      'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
      [workspaceId, sequenceId],
    );
    stepId = await one(
      `INSERT INTO sequence_steps
         (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
       VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3) RETURNING id`,
      [workspaceId, versionId, templateVersionId],
    );
    await database.session.query(
      `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, versionId, userId],
    );
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  /**
   * Run a worker on the fixed clock until `ready` holds, then until it has published
   * `passes` more of both gauges, and return those later values.
   */
  const runWorker = async (options: {
    readonly sources: readonly DueWorkSource[];
    readonly registry: HandlerRegistry;
    readonly ready: () => Promise<boolean>;
    readonly passes: number;
  }): Promise<{ readonly active: number[]; readonly held: number[] }> => {
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
        FSS_WORKER_LIVENESS_FILE: join(tmpdir(), `${database.name}-enrollment-liveness`),
      }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: options.registry,
      sources: options.sources,
      sink,
      log: recordingLogger(),
      now: () => new Date(AT),
    });
    const deadline = Date.now() + 20_000;
    let from = -1;
    const later = (name: string): number[] =>
      sink.published
        .slice(Math.max(from, 0))
        .filter((datum: MetricDatum) => datum.name === name)
        .map(datum => datum.value);
    try {
      while (Date.now() < deadline) {
        if (from < 0 && (await options.ready())) from = sink.published.length;
        if (from >= 0 && later('HeldEnrollments').length >= options.passes) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally {
      await worker.stop('test');
    }
    expect(from, 'the worker never reached the state the case waits for').toBeGreaterThanOrEqual(0);
    return { active: later('ActiveEnrollments'), held: later('HeldEnrollments') };
  };

  it('publishes 0 and 0 with nothing enrolled', async () => {
    const values = await runWorker({
      sources: [],
      registry: new HandlerRegistry(),
      ready: async () => await Promise.resolve(true),
      passes: 3,
    });
    expect(values.active.length).toBeGreaterThanOrEqual(3);
    expect(new Set(values.active)).toEqual(new Set([0]));
    expect(new Set(values.held)).toEqual(new Set([0]));
  });

  it('publishes 2 active and 0 held once the real send gate holds both due emails because sending is switched off', async () => {
    for (const prospect of prospects) {
      const enrollmentId = await one(
        `INSERT INTO sequence_enrollments
           (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
            firm_time_zone, holiday_calendar_version)
         VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1') RETURNING id`,
        [workspaceId, versionId, prospect.opportunityId, prospect.firmId, prospect.contactId, userId],
      );
      await database.session.query(
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, 'email', 1, $6::timestamptz, $6::timestamptz, $6::timestamptz,
                 'America/New_York', 'elapsed.1')`,
        [workspaceId, enrollmentId, stepId, prospect.firmId, prospect.contactId, DUE],
      );
    }

    const handoff = outboundSendHandoff({
      deps: {
        gmail: recordedGmailClient({ emailAddress: 'sales@example.test', historyId: '1', messages: [] }),
        oauth: {
          clientId: 'g72-test.apps.googleusercontent.test',
          clientSecret: randomBytes(24).toString('base64url'),
          redirectUri: 'https://api.example.test/oauth/gmail/callback',
          authorizationEndpoint: 'https://accounts.example.test/o/oauth2/v2/auth',
          tokenEndpoint: 'https://oauth2.example.test/token',
          revocationEndpoint: 'https://oauth2.example.test/revoke',
          apiBaseUrl: 'https://gmail.example.test',
        },
        cipher: localEnvelopeCipher('g72-test-envelope'),
        actor: 'g72-test-worker',
        // Production's state until the rehearsal gate passes and an admin enables it.
        deploymentSendingEnabled: false,
      },
    });
    const bothHeld = async (): Promise<boolean> => {
      const { rows } = await database.session.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM step_executions WHERE workspace_id = $1 AND state = 'held'",
        [workspaceId],
      );
      return rows[0]?.count === '2';
    };
    const values = await runWorker({
      sources: [sequenceActionSource()],
      registry: new HandlerRegistry().register(sequenceActionJobHandler({ sendHandoff: handoff })),
      ready: bothHeld,
      passes: 3,
    });

    const steps = await database.session.query<{ state: string; hold_reason_code: string | null }>(
      'SELECT state, hold_reason_code FROM step_executions WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(steps.rows).toEqual([
      { state: 'held', hold_reason_code: 'scoped_pause' },
      { state: 'held', hold_reason_code: 'scoped_pause' },
    ]);
    // The gate's refusal, on the fence and nowhere else: no hold row was opened.
    const fences = await database.session.query<{ state: string; held_reason: string | null }>(
      'SELECT state, held_reason FROM outbound_messages WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(fences.rows).toEqual([
      { state: 'held', held_reason: 'workspace_sending_not_attested' },
      { state: 'held', held_reason: 'workspace_sending_not_attested' },
    ]);
    const holds = await database.session.query('SELECT 1 FROM active_holds WHERE workspace_id = $1', [workspaceId]);
    expect(holds.rows).toHaveLength(0);

    expect(values.held.length).toBeGreaterThanOrEqual(3);
    expect(new Set(values.active)).toEqual(new Set([2]));
    expect(new Set(values.held)).toEqual(new Set([0]));
  });

  it('publishes 2 held of 2 active once a workspace hold nobody chose is open', async () => {
    await withTransaction(database.session, async () =>
      await openHold(repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'migration' }), database.session), {
        scopeKind: 'workspace',
        reasonCode: 'mailbox_disconnected',
        blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
        sourceEventKind: 'test.workspace_hold',
      }),
    );

    const values = await runWorker({
      sources: [],
      registry: new HandlerRegistry(),
      ready: async () => await Promise.resolve(true),
      passes: 3,
    });
    expect(values.held.length).toBeGreaterThanOrEqual(3);
    expect(new Set(values.active)).toEqual(new Set([2]));
    expect(new Set(values.held)).toEqual(new Set([2]));
  });
});
