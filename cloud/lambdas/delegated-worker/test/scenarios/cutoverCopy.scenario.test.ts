import { describe, expect, it } from 'vitest';
import { ownerResearchSourceKey } from '../../../../../src/shared/contracts/ownerCommandContract';
import { REPLY_TEMPLATE_SEEDS } from '../../../../../src/main/outreach/templates/replyTemplateSeeds';
import { replyTemplateContentHash } from '../../../../../src/shared/contracts/replyTemplateContract';
import { cutoverTable, planCutoverCopy, runCutoverCopy, CUTOVER_ROWS } from '../../src/v1/cutover';
import { evidenceKey, evidenceRecordSchema } from '../../src/v1/evidence';
import { firmKey, firmRecordSchema } from '../../src/v1/firmsWrite';
import { RESEARCH_SETTINGS_KEY, researchSettingsSchema } from '../../src/v1/pool';
import { sequenceKey, sequenceRecordSchema } from '../../src/v1/sequence';
import { suppressionFirmKey, suppressionHandleKey, suppressionFirmRecordSchema } from '../../src/v1/suppression';
import { SENDING_SETTINGS_KEY, sendingSettingsSchema, templateKey, templateRecordSchema } from '../../src/v1/templates';
import { listAttempts } from '../../src/v1/attempts';
import { dispatchCapPolicyKey } from '../../src/remoteGoogleAuthorization';
import { replyTemplateStateKey } from '../../src/territoryPolicyRepository';
import { enrollFirm, listedRouteId, putCallEvidence, putFirm, putMailSuppression, putRetiredRoute, putTerritoryPolicy, riFirm } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * The cutover copy (slice S6, FSS target design section 8): every old key the rebuilt core needs, read once and
 * written under the new sort keys with `attribute_not_exists` puts. The dry run is the whole plan with no write at
 * all; the execute is the same plan committed, and running it twice writes nothing the second time. Nothing here
 * deletes, and the Google grant, the event log, the pairings and the device tokens are never read for a target.
 */

const START = '2026-09-19T12:00:00.000Z';
const seedOf = (id: string) => REPLY_TEMPLATE_SEEDS.find(entry => entry.id === id)!;

async function workspaceWithOldRecords(f: ReturnType<typeof v1Fixture>) {
  const store = f.store;
  const policy = await putTerritoryPolicy(store, '2026-09-01T12:00:00.000Z');
  // Three researched firms: one plain, one mid-sequence with a logged old-key call, one suppressed by mail.
  const plain = riFirm(1, { businessEmail: 'hello@rhodeislandfirm1.example' });
  const walked = riFirm(2);
  const stopped = riFirm(3);
  for (const input of [plain, walked, stopped]) await putFirm(store, input);
  const enrolled = await enrollFirm(store, { firmId: walked.id, routeId: listedRouteId(walked.id, walked.phone!), policy,
    startedAt: '2026-09-12T13:00:00.000Z', stepIndex: 1 });
  await putCallEvidence(store, { enrollment: enrolled.enrollment, version: enrolled.version,
    routeId: listedRouteId(walked.id, walked.phone!), outcome: 'voicemail', observedAt: '2026-09-12T13:05:00.000Z' });
  await putMailSuppression(store, stopped.id, '2026-09-13T09:00:00.000Z');
  await putRetiredRoute(store, { firmId: plain.id, routeId: listedRouteId(plain.id, plain.phone!), retiredAt: '2026-09-14T10:00:00.000Z' });
  // The worker's own template state: T1 approved at the seeded text, the other four never touched.
  const seed = seedOf('T1');
  await store.transact([store.put(replyTemplateStateKey(store.options.workspaceId), {
    approvals: [{ templateId: 'T1', revision: 1, subject: seed.subject, body: seed.body,
      contentHash: replyTemplateContentHash({ id: 'T1', revision: 1, subject: seed.subject, body: seed.body }),
      approvedAt: '2026-09-15T10:00:00.000Z', commandId: '11111111-1111-4111-8111-111111111111' }],
    paused: false, updatedAt: '2026-09-15T10:00:00.000Z' }, null)]);
  await store.transact([store.put(dispatchCapPolicyKey('founder@callie.example'),
    { sender: 'founder@callie.example', dailyLimit: 20, ramp: { startPerDay: 5, stepPerDay: 1, maxPerDay: 20 } }, null)]);
  // The old research configuration, which is where the new query grid comes from.
  await store.transact([store.put(ownerResearchSourceKey(), { version: 1, workspaceId: 'ws', pairingId: 'fictional-pairing', revision: 1, state: 'active',
    research: { workspaceId: 'ws', budgetId: 'places-territory-v1',
      audience: { residential: true, regions: ['Providence, RI'], terms: ['property management company'] },
      audienceRevision: 1, sourceRevision: 1, budgetRevision: 1,
      discoveryLimits: { maxCompanies: 20, maxPages: 1, maxBytes: 10000, maxCostMicros: 35000 },
      researchLimits: { maxCompanies: 20, maxPages: 4, maxBytes: 200000, maxCostMicros: 1000 },
      capability: { model: 'fictional-reviewed-model', webSearch: true, searchCostMicros: 35000, modelCostMicros: 1000 }, maxAccountBudgetMicros: 1000,
      permittedSources: [], preparationCommandId: '00000000-0000-4000-8000-000000000001', discoveryProvider: 'places' } }, null)]);
  // The Google grant and one event: never a source and never a target of the copy.
  await store.transact([store.put('GOOGLE_GRANT#fictional-pairing', { revoked: false, grant: { email: 'founder@callie.example', subject: 'sub-1' } }, null)]);
  await store.transact([store.put('EVENT_HEAD', { sequence: 1 }, null)]);
  return { plain, walked, stopped, policy, enrolled };
}

describe('the cutover copy', () => {
  it('plans every row and writes nothing at all on a dry run', async () => {
    const f = v1Fixture(START);
    const { plain } = await workspaceWithOldRecords(f);
    const before = f.db.transactions.length;
    const report = await runCutoverCopy(f.store, { execute: false });
    expect(f.db.transactions.length).toBe(before);
    expect(f.db.inspect(firmKey(plain.id))).toBeUndefined();
    expect(f.db.inspect(SENDING_SETTINGS_KEY)).toBeUndefined();
    expect(report.executed).toBe(false);
    expect(report.rows.map(row => row.target)).toEqual([...CUTOVER_ROWS]);
    const byTarget = new Map(report.rows.map(row => [row.target, row]));
    expect(byTarget.get('FIRM#')).toMatchObject({ count: 3, wouldWrite: 3, alreadyPresent: 0, refused: 0 });
    expect(byTarget.get('EVIDENCE#')).toMatchObject({ count: 3, wouldWrite: 3, alreadyPresent: 0 });
    expect(byTarget.get('TEMPLATE#')).toMatchObject({ count: 5, wouldWrite: 5 });
    expect(byTarget.get('SETTINGS#sending')).toMatchObject({ count: 1, wouldWrite: 1 });
    expect(byTarget.get('SETTINGS#research')).toMatchObject({ count: 1 });
    // The suppressed firm plus the retired route: one firm record, its handles, and the retired number.
    expect(byTarget.get('SUPPRESS#')!.wouldWrite).toBeGreaterThan(0);
    expect(byTarget.get('SEQ#')).toMatchObject({ count: 1, wouldWrite: 1, refused: 0 });
    // The dry run's table names the source, the target and the three counts on every row.
    const table = cutoverTable(report.rows);
    expect(table).toContain('ACCOUNT#');
    expect(table).toContain('would-write');
    expect(table).toContain('already-present');
    expect(table).toContain('refused');
    // No attempt is recorded for a run that did nothing.
    expect(await listAttempts(f.store, { kind: 'operator' })).toEqual([]);
  });

  it('writes the new keys on execute, and a second execute writes nothing', async () => {
    const f = v1Fixture(START);
    const { plain, walked, stopped, enrolled } = await workspaceWithOldRecords(f);
    const first = await runCutoverCopy(f.store, { execute: true });
    expect(first.executed).toBe(true);
    expect(first.rows.every(row => row.refused === 0)).toBe(true);

    const firm = firmRecordSchema.parse(f.db.inspect(firmKey(plain.id)));
    expect(firm).toMatchObject({ firmId: plain.id, state: 'RI', timeZone: 'America/New_York', derivedZoneFrom: 'territory_state_map', enteredBy: 'research' });
    expect(firm.routes.map(route => route.channel).sort()).toEqual(['email', 'phone']);
    const evidence = evidenceRecordSchema.parse(f.db.inspect(evidenceKey(plain.id)));
    expect(evidence.sources.length).toBeGreaterThan(0);
    expect(evidence.businessEmailFinding?.email).toBe('hello@rhodeislandfirm1.example');

    // The template bodies come from the seeds; T1 keeps the approval the worker held.
    const t1 = templateRecordSchema.parse(f.db.inspect(templateKey('T1')));
    expect(t1.body).toBe(seedOf('T1').body);
    expect(t1.approval.state).toBe('approved');
    const t2 = templateRecordSchema.parse(f.db.inspect(templateKey('T2')));
    expect(t2.approval.state).toBe('draft');

    const sending = sendingSettingsSchema.parse(f.db.inspect(SENDING_SETTINGS_KEY));
    expect(sending.dailyLimit).toBe(20);
    expect(sending.ramp).toEqual({ startPerDay: 5, stepPerDay: 1, maxPerDay: 20 });
    researchSettingsSchema.parse(f.db.inspect(RESEARCH_SETTINGS_KEY));

    // The mid-sequence firm's `SEQ#` is anchored on the enrollment it is actually running.
    const sequence = sequenceRecordSchema.parse(f.db.inspect(sequenceKey(walked.id)));
    expect(sequence.startedAt).toBe(enrolled.enrollment.startedAt);
    expect(sequence.currentStepId).toBe(enrolled.enrollment.currentStepId);
    expect(sequence.enrollmentId).toBe(enrolled.enrollment.id);
    // The plain firm has nothing said to it, so nothing claims it is in a sequence.
    expect(f.db.inspect(sequenceKey(plain.id))).toBeUndefined();

    // The suppressed firm stays suppressed: the new set carries it, and the copy never unsuppresses anything.
    const suppression = suppressionFirmRecordSchema.parse(f.db.inspect(suppressionFirmKey(stopped.id)));
    expect(suppression.source).toBe('reply');
    expect(f.db.inspect(suppressionHandleKey(stopped.phone!))).toBeDefined();
    // The retired route of a firm that is not suppressed is a suppressed handle, not a suppressed firm.
    expect(f.db.inspect(suppressionHandleKey(plain.phone!))).toBeDefined();
    expect(f.db.inspect(suppressionFirmKey(plain.id))).toBeUndefined();

    // One `operator` attempt per table row.
    const attempts = await listAttempts(f.store, { kind: 'operator', limit: 20 });
    expect(attempts.length).toBe(CUTOVER_ROWS.length);
    expect(attempts.every(attempt => attempt.outcome === 'ok')).toBe(true);

    const committed = f.db.transactions.length;
    const second = await runCutoverCopy(f.store, { execute: true });
    expect(second.rows.every(row => row.wouldWrite === 0)).toBe(true);
    expect(second.rows.some(row => row.alreadyPresent > 0)).toBe(true);
    // The second run records its attempts and nothing else; no target row is written twice.
    expect(f.db.transactions.length - committed).toBe(CUTOVER_ROWS.length);
    expect(firmRecordSchema.parse(f.db.inspect(firmKey(plain.id))).enteredAt).toBe(firm.enteredAt);
  });

  it('never reads the grant, the event log, the pairings or the tokens for a target, and never deletes', async () => {
    const f = v1Fixture(START);
    await workspaceWithOldRecords(f);
    await runCutoverCopy(f.store, { execute: true });
    // Everything the copy wrote is a Put with an absent-key condition; there is no Delete in the vocabulary at all.
    const written = f.db.transactions.flatMap(transaction => transaction.TransactItems ?? []);
    expect(written.every(item => item.Delete === undefined)).toBe(true);
    // The grant and the event head stand exactly as they were, and nothing new carries their prefixes.
    expect(f.db.inspect('GOOGLE_GRANT#fictional-pairing')).toEqual({ revoked: false, grant: { email: 'founder@callie.example', subject: 'sub-1' } });
    expect(f.db.inspect('EVENT_HEAD')).toEqual({ sequence: 1 });
    const keys = f.db.dump().map(item => String(item.sk?.S));
    expect(keys.filter(key => key.startsWith('GRANT#'))).toEqual([]);
    expect(keys.filter(key => key.startsWith('EVENT#'))).toEqual([]);
    expect(keys.filter(key => key.startsWith('DEVICE#'))).toEqual([]);
  });

  it('plans the same rows whether or not a firm already carries its new record', async () => {
    const f = v1Fixture(START);
    const { plain } = await workspaceWithOldRecords(f);
    await runCutoverCopy(f.store, { execute: true });
    const plan = await planCutoverCopy(f.store);
    const firms = plan.find(row => row.target === 'FIRM#')!;
    expect(firms.count).toBe(3);
    expect(firms.wouldWrite).toBe(0);
    expect(firms.alreadyPresent).toBe(3);
    expect(firms.items).toEqual([]);
    expect(f.db.inspect(firmKey(plain.id))).toBeDefined();
  });
});
