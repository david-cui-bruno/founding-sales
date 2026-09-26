import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { claimJobs, reclaimExpiredLeases, type ClaimedJob } from '@fss/domain/jobs/jobStore.ts';
import type { GmailClient } from '@fss/domain/mail/gmailClient.ts';
import type { RecordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { readFenceByStepExecution, readFenceEvents } from '@fss/domain/outbound/fence.ts';
import { setAdminCap } from '@fss/domain/outbound/ramp.ts';
import { openHold, releaseHold } from '@fss/domain/policy/holds.ts';
import {
  createOutboundWorld,
  type OutboundWorld,
} from '../../../packages/domain/test/outbound/support/outboundWorld.ts';
import {
  openExtraSession,
  seedFirm,
  tracked,
  waitUntilSleeping,
  type ExtraSession,
} from '../../../packages/domain/test/outbound/support/dispatchFixtures.ts';
import { outboundSendHandoff } from '../src/handlers/outboundSendHandoff.ts';
import { sequenceActionJobHandler, sequenceActionSource } from '../src/handlers/sequenceAction.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';

/**
 * The `sequence.action` wake, end to end: the scheduler's source, the runner and the
 * handler over G7-2's real fence, with only Gmail recorded (audit C02, C03,
 * C05).
 *
 * * **C02** — a step the day's cap held is asked again once its hour has passed, under a
 *   new job, and sent once, rather than colliding with its first job's `done` key.
 * * **C03** — the worker dies between the step's transaction (which marks the step
 *   `dispatched` and prepares its fence) and the dispatch claim: the backend is killed
 *   inside the claiming transaction, exactly the gap in which the old retry read
 *   `dispatched`, did nothing and completed. The retry now dispatches the prepared
 *   fence through the one dispatch path, and so does the scheduler's recovery wake if
 *   the job itself is gone. Once, both ways.
 * * **Two wakes of one step** both get past the precheck and the token refresh, and the
 *   claim lets exactly one of them send.
 * * **C05** — a step an administrator's pause held is not asked while the pause is open,
 *   and the pass after its release wakes it, resumes it with 4.3's shift, and sends.
 *
 * Wednesday 23 September 2026 at 09:30 New York is the due instant and the dispatch
 * clock. No real person, firm or address appears.
 */

const DUE = '2026-09-23T13:30:00.000Z';

let world: OutboundWorld;
let second: ExtraSession;
let third: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  second = await openExtraSession(world);
  third = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await second?.close();
  await third?.close();
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());
const session = () => world.database.session;

/** Every other test's work out of the way, so a pass materializes only this test's step. */
beforeEach(async () => {
  await session().query(
    `UPDATE step_executions
        SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'test isolation',
            hold_reason_code = NULL, updated_at = now()
      WHERE state IN ('pending', 'held', 'dispatched')`,
  );
  await session().query("DELETE FROM jobs WHERE kind = 'sequence.action' AND state <> 'done'");
  await world.clearHolds(workspaceId());
});

interface DueStep {
  readonly executionId: string;
  readonly enrollmentId: string;
  readonly firmId: string;
}

/** A due email step for a firm of its own, with the contact's route the step will use. */
async function dueEmailStep(label: string): Promise<DueStep> {
  const firm = await seedFirm(world, world.alpha, label);
  const executionId = await makeStepExecution(session(), {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
  });
  const { rows } = await session().query<{ enrollment_id: string; contact_id: string }>(
    'SELECT enrollment_id, contact_id FROM step_executions WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), executionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the fixture step execution is missing');
  await session().query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1')`,
    [workspaceId(), firm.firmId, row.contact_id, `enrolled.${label}@prospect.example.test`],
  );
  await session().query(
    `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), executionId, DUE],
  );
  return { executionId, enrollmentId: row.enrollment_id, firmId: firm.firmId };
}

function registryFor(gmail: GmailClient): HandlerRegistry {
  const handler = sequenceActionJobHandler({
    sendHandoff: outboundSendHandoff({ deps: world.sendDeps(world.alpha, { gmail, now: () => new Date(DUE) }) }),
  });
  return new HandlerRegistry().register(handler);
}

/** One scheduler pass at database now, with the sequence source only. */
async function pass(): Promise<number> {
  const { rows } = await session().query<{ now: Date }>('SELECT now() AS now');
  const report = await runSchedulerPass(session(), {
    sources: [sequenceActionSource()],
    now: (rows[0]?.now ?? new Date()).toISOString(),
  });
  return report.inserted;
}

async function claimAll(): Promise<ClaimedJob[]> {
  return await claimJobs(session(), { owner: 'g82-worker', kinds: ['sequence.action'], limit: 10, leaseSeconds: 60 });
}

/** Claim and run every runnable `sequence.action` job, the way the worker loop does. */
async function runQueued(gmail: GmailClient): Promise<string[]> {
  const registry = registryFor(gmail);
  const outcomes: string[] = [];
  for (const job of await claimAll()) outcomes.push(await runClaimedJob(session(), { registry, job }));
  return outcomes;
}

async function execution(step: DueStep): Promise<{ state: string; hold_reason_code: string | null }> {
  const { rows } = await session().query<{ state: string; hold_reason_code: string | null }>(
    'SELECT state, hold_reason_code FROM step_executions WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), step.executionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no such execution');
  return row;
}

async function jobsFor(step: DueStep): Promise<number> {
  const { rows } = await session().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM jobs WHERE kind = 'sequence.action' AND payload ->> 'stepExecutionId' = $1",
    [step.executionId],
  );
  return Number(rows[0]?.count ?? '0');
}

/** The claim transitions the fence's ledger records: each one is an authorization to call Gmail. */
async function claims(step: DueStep): Promise<number> {
  const fence = await readFenceByStepExecution(context(), step.executionId);
  if (fence === null) return 0;
  const events = await readFenceEvents(context(), fence.id);
  return events.filter(event => event.fromState === 'prepared' && event.toState === 'dispatching').length;
}

/**
 * Run the step's job on a backend that is killed inside the dispatch's claiming
 * transaction: after the step's own transaction committed `dispatched` and the fence,
 * before the claim could commit. Returns the job, still `running` under a dead lease.
 */
async function dieBetweenCommitAndClaim(step: DueStep, gmail: RecordedGmailClient): Promise<ClaimedJob> {
  expect(await pass()).toBe(1);
  const [job] = await claimAll();
  if (job === undefined) throw new Error('the step was not claimable');

  await session().query(`
    CREATE FUNCTION g82_pause_the_claim() RETURNS trigger LANGUAGE plpgsql AS $pause$
    BEGIN
      IF NEW.step_execution_id = '${step.executionId}'::uuid AND NEW.state = 'dispatching' AND OLD.state = 'prepared' THEN
        PERFORM pg_sleep(30);
      END IF;
      RETURN NEW;
    END;
    $pause$`);
  await session().query(
    'CREATE TRIGGER zz_g82_pause_the_claim BEFORE UPDATE ON outbound_messages FOR EACH ROW EXECUTE FUNCTION g82_pause_the_claim()',
  );
  const dying = await openExtraSession(world);
  try {
    const running = tracked(runClaimedJob(dying.session, { registry: registryFor(gmail), job }));
    await waitUntilSleeping(session(), dying.pid);
    await session().query('SELECT pg_terminate_backend($1)', [dying.pid]);
    await expect(running.promise).rejects.toThrow();
  } finally {
    await dying.close();
    await session().query('DROP TRIGGER zz_g82_pause_the_claim ON outbound_messages');
    await session().query('DROP FUNCTION g82_pause_the_claim()');
  }

  // What the crash left: the step's transaction committed, the claim did not.
  expect((await execution(step)).state).toBe('dispatched');
  expect((await readFenceByStepExecution(context(), step.executionId))?.state).toBe('prepared');
  expect(gmail.sends).toHaveLength(0);
  return job;
}

describe('C02: a step held by the day’s cap is asked again, and sent once', () => {
  it('a new job wakes it after its hour, where the old key collided with the done one', async () => {
    const step = await dueEmailStep('rearm-cap');
    const gmail = world.clientWith(world.alpha, {});
    await setAdminCap(context(), {
      mailboxId: world.alpha.mailboxId,
      adminUserId: world.alpha.workspace.admin.userId,
      lowerTo: 0,
    });
    try {
      expect(await pass()).toBe(1);
      expect(await runQueued(gmail)).toEqual(['completed']);
      expect(gmail.sends).toHaveLength(0);
      expect((await readFenceByStepExecution(context(), step.executionId))?.heldReason).toBe('daily_cap');
      expect(await execution(step)).toEqual({ state: 'held', hold_reason_code: 'daily_cap' });
      // Not a spin: its `not_before` is an hour out.
      expect(await pass()).toBe(0);
    } finally {
      await setAdminCap(context(), {
        mailboxId: world.alpha.mailboxId,
        adminUserId: world.alpha.workspace.admin.userId,
        lowerTo: null,
      });
    }

    // The hour passes. The row is not otherwise touched: its version is the hold's.
    await session().query(
      "UPDATE step_executions SET not_before = now() - interval '1 minute' WHERE workspace_id = $1 AND id = $2",
      [workspaceId(), step.executionId],
    );
    expect(await pass(), 'the wake is a new job, not a collision with the done one').toBe(1);
    expect(await runQueued(gmail)).toEqual(['completed']);

    expect(gmail.sends).toHaveLength(1);
    expect((await readFenceByStepExecution(context(), step.executionId))?.state).toBe('sent');
    expect((await execution(step)).state).toBe('completed');
    expect(await jobsFor(step)).toBe(2);
    expect(await claims(step)).toBe(1);
    // And done is done: nothing further is materialized for it.
    expect(await pass()).toBe(0);
  });
});

describe('C03: a worker that dies between the step’s commit and the claim', () => {
  it('the retry after the lease runs out dispatches the prepared fence, once', async () => {
    const step = await dueEmailStep('rearm-crash-retry');
    const gmail = world.clientWith(world.alpha, {});
    const job = await dieBetweenCommitAndClaim(step, gmail);

    await session().query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    expect(await reclaimExpiredLeases(session(), { limit: 10 })).toBe(1);
    expect(await runQueued(gmail)).toEqual(['completed']);

    expect(gmail.sends).toHaveLength(1);
    expect((await readFenceByStepExecution(context(), step.executionId))?.state).toBe('sent');
    expect((await execution(step)).state).toBe('completed');
    expect(await claims(step)).toBe(1);
  });

  it('with the job itself gone, the scheduler’s recovery wake dispatches it, once', async () => {
    const step = await dueEmailStep('rearm-crash-dead');
    const gmail = world.clientWith(world.alpha, {});
    const job = await dieBetweenCommitAndClaim(step, gmail);
    await session().query(
      `UPDATE jobs SET state = 'dead', dead_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1`,
      [job.id],
    );
    // Still inside the grace: the dispatch may merely be slow.
    expect(await pass()).toBe(0);

    // Ten minutes pass with nothing moving the row.
    await session().query(
      `UPDATE step_executions
          SET created_at = now() - interval '1 hour', updated_at = now() - interval '11 minutes'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), step.executionId],
    );
    expect(await pass()).toBe(1);
    expect(await runQueued(gmail)).toEqual(['completed']);

    expect(gmail.sends).toHaveLength(1);
    expect((await readFenceByStepExecution(context(), step.executionId))?.state).toBe('sent');
    expect((await execution(step)).state).toBe('completed');
    expect(await claims(step)).toBe(1);
  });

  it('two wakes of the stranded step, both past the precheck and the token refresh, claim once', async () => {
    const step = await dueEmailStep('rearm-race');
    const gmail = world.clientWith(world.alpha, {});
    const crashed = await dieBetweenCommitAndClaim(step, gmail);
    await session().query(
      "UPDATE jobs SET state = 'dead', dead_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
      [crashed.id],
    );

    // Two wakes of one step, as a retry and a recovery wake would be.
    for (const wake of ['race-a', 'race-b']) {
      await session().query(
        `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, max_attempts)
         VALUES ($1, 'sequence.action', $2::jsonb, $3, 4)`,
        [workspaceId(), JSON.stringify({ stepExecutionId: step.executionId }), `step-execution:${step.executionId}:${wake}`],
      );
    }
    const jobs = await claimAll();
    expect(jobs).toHaveLength(2);

    // Both dispatches wait at the token refresh — after the fence read `prepared` and
    // the precheck passed — until both have arrived, then race for the claim.
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>(resolve => {
      release = resolve;
    });
    const timeout = setTimeout(() => release(), 10_000);
    const barrier: GmailClient = {
      ...gmail,
      refreshAccessToken: async (...args: Parameters<GmailClient['refreshAccessToken']>) => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        return await gmail.refreshAccessToken(...args);
      },
    };
    const registry = registryFor(barrier);
    const [first, other] = jobs;
    if (first === undefined || other === undefined) throw new Error('two jobs were claimed');
    const outcomes = await Promise.all([
      runClaimedJob(second.session, { registry, job: first }),
      runClaimedJob(third.session, { registry, job: other }),
    ]);
    clearTimeout(timeout);

    expect(arrived, 'both wakes reached the token refresh, so both passed the precheck').toBe(2);
    expect(outcomes).toEqual(['completed', 'completed']);
    expect(gmail.sends).toHaveLength(1);
    expect(await claims(step)).toBe(1);
    expect((await readFenceByStepExecution(context(), step.executionId))?.state).toBe('sent');
    expect((await execution(step)).state).toBe('completed');
  });
});

describe('C05: releasing a hold wakes the step it blocked, and resumes it', () => {
  it('a paused step sleeps while the pause is open and is sent, shifted by the pause, after the release', async () => {
    const step = await dueEmailStep('rearm-pause');
    await session().query(
      `UPDATE sequence_enrollments SET started_at = now() - interval '1 day', created_at = now() - interval '1 day'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), step.enrollmentId],
    );
    const gmail = world.clientWith(world.alpha, {});
    const pause = await openHold(context(), {
      scopeKind: 'firm',
      scopeKey: step.firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'administrative_pause',
      recoveryAction: 'release_pause',
    });

    expect(await pass()).toBe(1);
    expect(await runQueued(gmail)).toEqual(['completed']);
    expect(await execution(step)).toEqual({ state: 'held', hold_reason_code: 'scoped_pause' });
    // While the pause is open the step is not asked again, however many passes run.
    expect(await pass()).toBe(0);
    expect(await pass()).toBe(0);

    await session().query("UPDATE active_holds SET started_at = now() - interval '2 hours' WHERE id = $1", [pause]);
    await releaseHold(context(), pause);
    expect(await pass(), 'the pass after the release wakes it').toBe(1);
    expect(await runQueued(gmail)).toEqual(['completed']);

    expect(gmail.sends).toHaveLength(1);
    expect((await execution(step)).state).toBe('completed');
    const { rows } = await session().query<{ shift_milliseconds: string }>(
      `SELECT shift_milliseconds::text FROM step_execution_shifts
        WHERE workspace_id = $1 AND step_execution_id = $2 AND reason = 'hold_union'`,
      [workspaceId(), step.executionId],
    );
    expect(rows).toHaveLength(1);
    const hours = Number(rows[0]?.shift_milliseconds ?? '0') / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
  });
});
