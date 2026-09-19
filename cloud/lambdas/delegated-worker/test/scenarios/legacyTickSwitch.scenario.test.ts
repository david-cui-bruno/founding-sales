import { describe, expect, it } from 'vitest';
import { createProductionServices, createProductionHandler } from '../../src/handler';
import { dayKey } from '../../src/v1/dayBuild';
import { recordingQueue } from './researchFixtures';
import { putFirm, putTerritoryPolicy, riFirm, setPosture, tickOf } from './firmFixtures';
import { runScheduler } from '../../src/scheduler';
import { v1Fixture } from './v1Fixture';

/**
 * The last edit S6 makes to the old five-minute tick (FSS target design section 9). S3 took email off it and S4
 * took research off it, and what was still left was S1's list build. That moves to the scheduler as the `day`
 * job the scheduler has offered since S3, and the third switch,
 * `delegated_worker_legacy_tick_enabled = false` → `DELEGATED_WORKER_LEGACY_TICK_ENABLED=false`, leaves the old
 * function answering HTTP and nothing else.
 *
 * With all three switches false the old function still serves every route it served before — the desktop's event
 * sync, the pairing and Google routes and the readiness probe — and its scheduled invocation does no work at all.
 * The switch enables nothing: there is no value of it that makes the old tick do more.
 */

const START = '2026-09-19T12:00:00.000Z';
/** 10:00 UTC is 06:00 Eastern on this date, so the morning list is due. */
const AFTER_FIVE_EASTERN = '2026-09-19T10:00:00.000Z';
const HOST = 'worker.example.test';
const baseEnv = { DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: 'fictional-table', DELEGATED_WORKSPACE_ID: 'ws',
  DELEGATED_WORKER_HOST: HOST, AWS_REGION: 'us-east-1', DELEGATED_WORKER_SCHEDULE_ARN: 'arn:aws:events:us-east-1:123456789012:rule/delegated' };
const scheduledEvent = { source: 'aws.events', 'detail-type': 'Scheduled Event', resources: [baseEnv.DELEGATED_WORKER_SCHEDULE_ARN] };

/** One workspace with a firm the morning list would pick up, and David's posture for its state. */
async function readyWorkspace(f: ReturnType<typeof v1Fixture>) {
  await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  await putFirm(f.store, riFirm(1));
  const device = await f.pairDevice();
  await setPosture(f, device.bearer, 'RI', 'calling');
}

describe('the legacy tick switch on the old function', () => {
  it('no longer builds the morning list from the old tick, whatever the other switches say', async () => {
    const f = v1Fixture(AFTER_FIVE_EASTERN);
    await readyWorkspace(f);
    const tick = tickOf(f);
    await tick();
    // The list is the scheduler's `day` job now: the old tick leaves the day unbuilt.
    expect(f.db.inspect(dayKey('2026-09-19'))).toBeUndefined();
  });

  it('builds the day from the scheduler instead, as the `day` job it has offered since S3', async () => {
    const f = v1Fixture(AFTER_FIVE_EASTERN);
    await readyWorkspace(f);
    const queue = recordingQueue();
    const report = await runScheduler({ store: f.store, queue }, new AbortController().signal);
    expect(report.enqueued.some(job => job.kind === 'day.build' && job.jobId === 'day:2026-09-19')).toBe(true);
  });

  it('does nothing but answer HTTP when the tick switch is false', async () => {
    const f = v1Fixture(AFTER_FIVE_EASTERN);
    await readyWorkspace(f);
    const boundaries = { dynamo: f.store.options.dynamo, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } };
    const env = { ...baseEnv, DELEGATED_WORKER_LEGACY_EMAIL_ENABLED: 'false', DELEGATED_WORKER_LEGACY_RESEARCH_ENABLED: 'false',
      DELEGATED_WORKER_LEGACY_TICK_ENABLED: 'false' };
    const before = f.db.transactions.length;
    const handle = createProductionHandler(env, boundaries);
    const response = await handle(scheduledEvent) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: string; held: number; phases: Record<string, string>; mailPolls: number; dispatches: number };
    expect(body.status).toBe('inactive');
    expect(body.held).toBe(0);
    expect(body.mailPolls).toBe(0);
    expect(body.dispatches).toBe(0);
    expect(Object.values(body.phases).every(phase => phase === 'skipped')).toBe(true);
    // Not one write: no tick record, no attempt, no day record.
    expect(f.db.transactions.length).toBe(before);
    expect(f.db.inspect(dayKey('2026-09-19'))).toBeUndefined();

    // The function still answers HTTP: the readiness probe is served exactly as before.
    const readiness = await handle({ version: '2.0', rawPath: '/readiness', rawQueryString: '',
      headers: { host: HOST, 'x-forwarded-proto': 'https' }, isBase64Encoded: false,
      requestContext: { domainName: HOST, http: { method: 'GET', sourceIp: 'fictional' } } }) as { statusCode: number };
    expect(readiness.statusCode).not.toBe(503);
  });

  it('reads the switch from the environment, and only the exact string false turns it off', async () => {
    // A tick that ran writes its phase cursor, its attempts and its own record; a tick that did not writes nothing.
    for (const [value, ran] of [[undefined, true], ['true', true], ['false', false], ['TRUE', true], ['0', true]] as const) {
      const f = v1Fixture(START);
      const services = await createProductionServices({ ...baseEnv, ...(value === undefined ? {} : { DELEGATED_WORKER_LEGACY_TICK_ENABLED: value }) },
        { dynamo: f.store.options.dynamo, fetch: async () => { throw new Error('unconfigured fictional HTTP'); } });
      expect(services).not.toBeNull();
      const before = f.db.transactions.length;
      await services!.source.tick(new AbortController().signal);
      expect(f.db.transactions.length > before, `LEGACY_TICK_ENABLED=${String(value)}`).toBe(ran);
    }
  });
});
