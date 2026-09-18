import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import { createProductionHandler } from '../src/handler';
import { DynamoStore } from '../src/dynamoStore';
import { ConditionalCommandHarness } from './sdkHarness';
import { ownerSourceConfigurationSchema, ownerSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';

const arn = 'arn:aws:events:us-east-1:000000000000:rule/fictional-worker';
const secret = 'fictional-secret-token person@example.test https://private.invalid/?token=secret';
const schedule = () => ({ source: 'aws.events', 'detail-type': 'Scheduled Event', resources: [arn], detail: { private: secret } });
const environment = (): NodeJS.ProcessEnv => ({ DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_SCHEDULE_ARN: arn,
  DELEGATED_WORKER_TABLE: 'fictional-table', DELEGATED_WORKSPACE_ID: 'ws', DELEGATED_WORKER_HOST: 'worker.example.test', AWS_REGION: 'us-east-1' });
const googleEnvironment = (): NodeJS.ProcessEnv => ({ ...environment(), DELEGATED_GOOGLE_CLIENT_ID: 'fictional-client',
  DELEGATED_GOOGLE_SECRET_PARAMETER: '/delegated-worker/ws/secret', DELEGATED_GOOGLE_KEY_PARAMETER: '/delegated-worker/ws/key' });
const request = () => ({ version: '2.0', rawPath: '/google/status', rawQueryString: '',
  headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https', authorization: `Bearer ${secret}` },
  requestContext: { domainName: 'worker.example.test', http: { method: 'GET', sourceIp: 'fictional' } } });
function fixture() {
  const db = new ConditionalCommandHarness();
  vi.spyOn(db, 'send');
  const ssm = { send: vi.fn(async (_command: GetParameterCommand): Promise<never> => { void _command; throw new Error(secret); }) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('unexpected fake HTTP'); });
  const pageHttp = vi.fn(async () => { throw new Error('unexpected fake page HTTP'); });
  const resolve = vi.fn(async () => { throw new Error('unexpected fake DNS'); });
  const boundaries = { dynamo: db, ssm, fetch, pageHttp, resolve };
  return { db, ssm, boundaries, noProviders: () => {
    expect(fetch).not.toHaveBeenCalled(); expect(pageHttp).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  } };
}
async function expectSanitizedRejection(invocation: Promise<unknown>) {
  const error = await invocation.then(() => { throw new Error('expected schedule rejection'); }, error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('worker_unavailable');
  expect(error.cause).toBeUndefined();
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
  expect(`${String(error)}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain(secret);
  expect(error.stack).not.toContain('person@example.test');
  expect(error.stack).not.toContain(arn);
}

describe('production scheduled invocation failure boundary', () => {
  it('rejects a real configured SSM initialization failure with only a fixed sanitized Error', async () => {
    const f = fixture();
    await expectSanitizedRejection(createProductionHandler(googleEnvironment(), f.boundaries)(schedule()));
    expect(f.ssm.send).toHaveBeenCalledTimes(2);
    for (const [command] of f.ssm.send.mock.calls) {
      expect(command).toBeInstanceOf(GetParameterCommand);
      expect(command.input.WithDecryption).toBe(true);
    }
    expect(f.db.send).not.toHaveBeenCalled(); expect(f.db.transactions).toHaveLength(0); f.noProviders();
  });
  it.each(['base', 'partial-google'])('rejects recognized schedule %s configuration failure without leaking input', async kind => {
    const f = fixture(); const env = environment();
    if (kind === 'base') env.DELEGATED_WORKER_HOST = secret;
    else env.DELEGATED_GOOGLE_CLIENT_ID = secret;
    await expectSanitizedRejection(createProductionHandler(env, f.boundaries)(schedule()));
    expect(f.ssm.send).not.toHaveBeenCalled(); expect(f.db.send).not.toHaveBeenCalled(); expect(f.db.transactions).toHaveLength(0); f.noProviders();
  });
  it('returns successful idle from the real tick, without provider I/O', async () => {
    const f = fixture(); const result = await createProductionHandler(environment(), f.boundaries)(schedule());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'inactive', researchPrepared: 0, researchCompleted: 0,
      mailPolls: 0, dispatches: 0, sendReconciliations: 0, meetings: 0, held: 0, heldByReason: {},
      phases: { research: 'completed', configurations: 'completed', submittedCommands: 'completed', publications: 'completed' },
      extraction: { calls: 0, settledCostMicros: 0, refundedMicros: 0 }, ledger: null, descriptorExpired: false, selfPaused: false });
    expect(f.db.inspect('SOURCE_PHASE_CURSOR')).toEqual({ next: 0 });
    expect(f.db.inspect('SOURCE_LAST_TICK')).toMatchObject({ event: 'SCHEDULED_RUN_COMPLETED', version: 1, status: 'inactive', held: 0, places: null, firmsCreated: 0, jobsDrained: 0 });
    expect(f.db.transactions.length).toBeGreaterThanOrEqual(4);
    expect(f.ssm.send).not.toHaveBeenCalled(); f.noProviders();
  });
  it.each(['paused', 'held'])('preserves intentional %s tick results rather than inventing invocation failures', async state => {
    const f = fixture();
    const store = new DynamoStore({ dynamo: f.db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => '2026-09-14T00:00:00.000Z' } });
    const data = state === 'held' ? { malformed: secret } : ownerSourceConfigurationSchema.parse({ version: 1, workspaceId: 'ws',
      accountId: 'acct', pairingId: '00000000-0000-4000-a000-000000000001', revision: 1, state: 'paused',
      mailboxSubject: 'subject', calendarId: 'calendar@example.test', research: null });
    await store.transact([store.put(ownerSourceKey('acct'), data, null)]);
    const result = await createProductionHandler(environment(), f.boundaries)(schedule());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'inactive', held: state === 'held' ? 1 : 0, dispatches: 0, mailPolls: 0 });
    expect(result.body).not.toContain(secret); expect(f.ssm.send).not.toHaveBeenCalled(); f.noProviders();
  });
  it.each(['dependency', 'configuration'])('keeps HTTP %s failure as sanitized HTTP503', async failure => {
    const f = fixture(); const env = googleEnvironment();
    if (failure === 'configuration') env.DELEGATED_WORKER_HOST = secret;
    const result = await createProductionHandler(env, f.boundaries)(request());
    expect(result.statusCode).toBe(503); expect(JSON.parse(result.body)).toEqual({ error: 'worker_unavailable' });
    expect(result.headers['Cache-Control']).toBe('no-store'); expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.db.send).not.toHaveBeenCalled(); expect(f.db.transactions).toHaveLength(0); f.noProviders();
  });
  it.each(['wrong-arn', 'disabled', 'missing-arn', 'unknown-source', 'multiple-arns'])('keeps %s schedule inert with no writes', async kind => {
    const f = fixture(); const env = googleEnvironment(); const event = schedule();
    if (kind === 'wrong-arn') event.resources = [`${arn}-wrong`];
    if (kind === 'disabled') env.DELEGATED_WORKER_ENABLED = 'false';
    if (kind === 'missing-arn') delete env.DELEGATED_WORKER_SCHEDULE_ARN;
    if (kind === 'unknown-source') event.source = 'unknown';
    if (kind === 'multiple-arns') event.resources.push(arn);
    const result = await createProductionHandler(env, f.boundaries)(event);
    expect(result.statusCode).toBe(kind === 'disabled' ? 503 : 400);
    expect(JSON.parse(result.body)).toEqual({ error: kind === 'disabled' ? 'worker_disabled' : 'worker_invalid_request' });
    expect(f.db.send).not.toHaveBeenCalled(); expect(f.db.transactions).toHaveLength(0); expect(f.ssm.send).not.toHaveBeenCalled(); f.noProviders();
  });
});
