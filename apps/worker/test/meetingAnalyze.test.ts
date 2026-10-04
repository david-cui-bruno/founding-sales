import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetingOutcomesFixture } from '@fss/domain/test/meetings/support/meetingOutcomesFixture.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { meetingAnalysisPort } from '@fss/domain/meetings/analysisAdapter.ts';
import { scheduleMeetingAnalyses } from '@fss/domain/meetings/analysisJobs.ts';
import { registerHandlers, workerDueWorkSources, workerSourceFlags } from '../src/bootstrap/main.ts';
import { readMeetingAnalysisComposition } from '../src/handlers/meetingAnalyze.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
describe('meeting analysis through the real worker', () => {
  let f: Awaited<ReturnType<typeof meetingOutcomesFixture>>;
  beforeEach(async () => { f = await meetingOutcomesFixture(); });
  afterEach(async () => { await f.db.drop(); });
  it('registers analysis only with an available Bedrock composition', () => {
    const unavailable = readMeetingAnalysisComposition(undefined, { FSS_AWS_ACCOUNT_ID: '123456789012' });
    expect(unavailable.options).toBeNull();
    const port = meetingAnalysisPort({ transport: { kind: 'bedrock', countTokens: async () => 100, create: async () => ({}) } });
    const composition = { classifier: undefined, mail: undefined, send: undefined, research: undefined, meetingAnalysis: { accountId: '123456789012', port } };
    expect(registerHandlers(new HandlerRegistry(), composition).get('meeting.analyze')).toBeDefined();
    expect(workerSourceFlags(composition).meetingAnalysis).toBe(true);
    expect(workerDueWorkSources(workerSourceFlags(composition)).map(s => s.name)).toContain('meeting-analysis');
  });
  it('materializes notes while disabled then sends once after credit authorization', async () => {
    const { meetingAnalyzeJobHandler } = await import('../src/handlers/meetingAnalyze.ts');
    let calls = 0;
    const port = meetingAnalysisPort({ transport: { kind: 'bedrock', countTokens: async () => 100,
      create: async () => { calls++; return { usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: JSON.stringify({ overview: 'Discussed maintenance.', items: [], reviewReasons: [] }) }] }; } } });
    const registry = new HandlerRegistry().register(meetingAnalyzeJobHandler({ accountId: '123456789012', port }));
    const meetingId = await f.meeting(); await f.save(meetingId, 'Discussed maintenance.');
    expect((await runOnce(f.db.session, { registry, owner: 'meeting-analysis-fixture', limit: 5 })).failed).toBe(0);
    expect(calls).toBe(0);
    expect((await f.db.session.query('SELECT state FROM meeting_analyses')).rows).toEqual([{ state: 'pending' }]);
    await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_analysis', value: { enabled: true, dailyCeilingCents: 100,
      creditCoverage: { accountId: '123456789012', service: 'bedrock', evidenceRef: 'synthetic', verifiedAt: '2026-01-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z', status: 'verified' } } }));
    const at = new Date().toISOString();
    await withTransaction(f.db.session, async () => { for (const job of await scheduleMeetingAnalyses(f.db.session, at)) await enqueueJob(f.db.session, job); });
    expect((await runOnce(f.db.session, { registry, owner: 'meeting-analysis-fixture', limit: 5 })).failed).toBe(0);
    expect(calls).toBe(1);
    expect((await f.db.session.query('SELECT state,tasks_pending FROM meeting_analyses')).rows).toEqual([{ state: 'ready', tasks_pending: true }]);
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE subject_kind=$1', ['meeting_analysis'])).rows).toEqual([{ state: 'settled', settled_cents: 1 }]);
    await runOnce(f.db.session, { registry, owner: 'meeting-analysis-restart', limit: 5 });
    expect(calls).toBe(1);
  });
});
