import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import { createProductionHandler } from '../src/handler';
import { emptyTickReport, hold, type SourceTickReport } from '../src/sourceCoordinator';
import { buildScheduledRunRecord, logScheduledRun, scheduledRunRecordFields } from '../src/tickLog';
import { ConditionalCommandHarness } from './sdkHarness';

const at = '2026-09-18T12:00:00.000Z';
const firm = 'Alpha Residential Management';
const phone = '+14015550101';
const url = 'https://alpha-pm.example/';
function healthy(): SourceTickReport {
  const report = emptyTickReport();
  report.status = 'completed'; report.researchPrepared = 2; report.researchCompleted = 2;
  report.phases = { research: 'completed', configurations: 'completed', submittedCommands: 'completed', publications: 'completed' };
  report.places = { outcome: 'completed', runId: '11111111-1111-4111-8111-111111111111', created: 2, routes: 2, enqueued: 2, drained: 2,
    skipped: { no_website: 1, website_blocked: 0, duplicate_domain: 0, duplicate_phone: 0, existing_domain: 0, existing_phone: 0, route_held: 0, enqueue_held: 0 } };
  report.extraction = { calls: 2, settledCostMicros: 864, refundedMicros: 19136 };
  report.ledger = { discoveryRemainingMicros: 70000, researchRemainingMicros: 99136 };
  return report;
}

describe('scheduled tick record', () => {
  it('carries exactly the closed field list for a healthy tick, with firms created and jobs drained taken from the Places batch', () => {
    const record = buildScheduledRunRecord(healthy(), { at, durationMs: 1234.6 });
    expect(Object.keys(record).sort()).toEqual([...scheduledRunRecordFields].sort());
    expect(record).toMatchObject({ event: 'SCHEDULED_RUN_COMPLETED', version: 1, at, durationMs: 1235, status: 'completed', held: 0, heldByReason: {},
      firmsCreated: 2, jobsDrained: 2, extraction: { calls: 2, settledCostMicros: 864, refundedMicros: 19136 }, ledger: { discoveryRemainingMicros: 70000, researchRemainingMicros: 99136 },
      descriptorExpired: false, selfPaused: false, places: { outcome: 'completed', created: 2, skipped: { no_website: 1 } } });
    // The Places batch id is a derived identifier the log has no use for; only counts and the outcome cross into the record.
    expect(record.places).not.toHaveProperty('runId');
    expect(Object.keys(record.places!).sort()).toEqual(['created', 'drained', 'enqueued', 'outcome', 'routes', 'skipped']);
  });
  it('names every hold by reason so the sum of reasons is the held count, and marks an expired descriptor and the self-pause', () => {
    const report = emptyTickReport();
    hold(report, 'research_parked'); hold(report, 'research_parked'); hold(report, 'dispatch_held');
    report.descriptorExpired = true; report.selfPaused = true; report.phases = { research: 'held', configurations: 'completed', submittedCommands: 'aborted', publications: 'skipped' };
    const record = buildScheduledRunRecord(report, { at, durationMs: 45000 });
    expect(record.held).toBe(3);
    expect(record.heldByReason).toEqual({ research_parked: 2, dispatch_held: 1 });
    expect(Object.values(record.heldByReason).reduce((sum, value) => sum + value, 0)).toBe(record.held);
    expect(record).toMatchObject({ descriptorExpired: true, selfPaused: true, phases: { research: 'held', submittedCommands: 'aborted', publications: 'skipped' }, places: null, ledger: null });
  });
  it('never lets a firm name, phone, URL or any unlisted report property into the record', () => {
    const report = healthy() as SourceTickReport & Record<string, unknown>;
    report.firmName = firm; report.lastPhone = phone; report.lastUrl = url; report.error = new Error(`private ${firm}`);
    (report.places as Record<string, unknown>).name = firm;
    const lines: string[] = [];
    const record = logScheduledRun(report, { at, durationMs: 10 }, line => lines.push(line));
    expect(record).not.toBeNull();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    for (const secret of [firm, phone, url, 'private', 'runId', '11111111']) expect(line).not.toContain(secret);
    expect(Object.keys(JSON.parse(line) as object).sort()).toEqual([...scheduledRunRecordFields].sort());
  });
  it('logs nothing at all when the report cannot be expressed within the schema', () => {
    const report = Object.assign(healthy(), { status: `completed ${firm}` }) as unknown as SourceTickReport;
    const lines: string[] = [];
    expect(logScheduledRun(report, { at, durationMs: 10 }, line => lines.push(line))).toBeNull();
    expect(lines).toEqual([]);
    expect(() => buildScheduledRunRecord({ ...healthy(), held: -1 } as SourceTickReport, { at, durationMs: 10 })).not.toThrow();
    expect(() => buildScheduledRunRecord({ ...healthy(), places: { ...healthy().places!, outcome: firm as 'held' } }, { at, durationMs: 10 })).toThrow();
  });
  it('writes exactly one JSON line from the real scheduled handler and persists the same record as the last tick', async () => {
    const arn = 'arn:aws:events:us-east-1:000000000000:rule/fictional-worker';
    const db = new ConditionalCommandHarness();
    const ssm = { send: vi.fn(async (_command: GetParameterCommand): Promise<never> => { void _command; throw new Error('unexpected SSM'); }) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = createProductionHandler({ DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_SCHEDULE_ARN: arn, DELEGATED_WORKER_TABLE: 'fictional-table', DELEGATED_WORKSPACE_ID: 'ws', DELEGATED_WORKER_HOST: 'worker.example.test', AWS_REGION: 'us-east-1' },
      { dynamo: db, ssm, fetch: async () => { throw new Error('unexpected HTTP'); }, pageHttp: async () => { throw new Error('unexpected page HTTP'); }, resolve: async () => { throw new Error('unexpected DNS'); } });
    const result = await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event', resources: [arn], detail: { private: firm } });
    expect(result.statusCode).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([...scheduledRunRecordFields].sort());
    expect(record).toMatchObject({ event: 'SCHEDULED_RUN_COMPLETED', status: 'inactive', held: 0, places: null, descriptorExpired: false });
    expect(line).not.toContain(firm); expect(line).not.toContain(arn);
    expect(db.inspect('SOURCE_LAST_TICK')).toMatchObject({ event: 'SCHEDULED_RUN_COMPLETED', status: 'inactive', held: 0 });
    log.mockRestore();
  });
});
