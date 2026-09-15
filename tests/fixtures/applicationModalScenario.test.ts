/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { installApplicationModalScenario, modalMethods, type ModalMethod } from './applicationModalScenario';
import { leadsListRequestSchema } from '../../src/shared/contracts/leadsContract';
import { dailySnapshotSchema } from '../../src/shared/contracts/dailyContract';
import { requestedFollowupDraftSchema } from '../../src/shared/contracts/requestedFollowupContract';
import { leadDetailSchema } from '../../src/shared/contracts/leadDetailContract';
import { captureLearningRequestSchema, learningsListRequestSchema } from '../../src/shared/contracts/learningsContract';
import { logPastActivityRequestSchema } from '../../src/shared/contracts/todayContract';
import { overrideDiscoveryRequestSchema } from '../../src/shared/contracts/discoveryContract';
import { importSourceSchema, importCommitRequestSchema } from '../../src/shared/contracts/importContract';

const T = '2026-09-10T12:00:00.000Z';
const P = 'person-kevin';
const C = 'cycle-kevin';
const learningQuery = learningsListRequestSchema.parse({ categories: [], statuses: [], query: '', limit: 200 });
const leadQuery = leadsListRequestSchema.parse({ query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 200 });
const capture = captureLearningRequestSchema.parse({ category: 'pain', statement: 'Owners lose weekends to showings.', confidence: 'medium', evidence: [
  { personId: null, activityId: null, quote: 'I lose Saturday to showings.', notedAt: T },
  { personId: null, activityId: null, quote: 'And Sunday too.', notedAt: T },
], contradictionOf: null });
const source = importSourceSchema.parse({ kind: 'spreadsheet_paste', sourceName: 'Pasted rows', content: 'Name,Email\nAlex Example,alex@example.test' });
const manual = logPastActivityRequestSchema.parse({ personId: P, salesCycleId: C, kind: 'call', direction: 'outbound', occurredAt: '2026-09-09T16:00:00.000Z', summary: 'Discussed price.', outcome: 'price_said' });
const discovery = overrideDiscoveryRequestSchema.parse({ commandId: '30000000-0000-4000-8000-000000000003', personId: P, assessmentId: '10000000-0000-4000-8000-000000000001', expectedFingerprint: 'a'.repeat(64), decision: 'watch', reason: 'Wait for the next season.' });
function nativeDaily() {
  const hash = 'a'.repeat(64);
  const originalCall = { commandId: 'call', handoffId: 'handoff', actionId: 'action', commandFingerprint: hash, outcomeEventId: 'event', outcomeEventHash: hash };
  const draft = requestedFollowupDraftSchema.parse({
    kind: 'requested_phone_followup', id: 'draft-a', accountId: 'a', revision: 1, mailboxSubject: 'mailbox', sender: 'founder@fixture.invalid', recipient: 'a@fixture.invalid',
    recipientBinding: { kind: 'owner_supplied', email: 'a@fixture.invalid', originalCall }, accountVersion: 1, researchRevision: 1, contextRevision: hash, originalCall,
    mailContext: { scopeRevision: null, scopeFingerprint: null, inboundContextRevision: null, inboundContextFingerprint: hash }, subject: 'Information for a', body: 'Saved note for a', evidenceIds: ['event'], generation: 'edited', updatedAt: T,
  });
  return dailySnapshotSchema.parse({
    workspaceId: 'ws', workflowMode: 'meeting_first', revision: hash, freshness: { kind: 'local_snapshot', generatedAt: T, remote: 'unknown' },
    accounts: [{ account: { id: 'a', name: 'Account A', domain: null, version: 1 }, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: hash }],
    calls: { accountIds: ['a'], workloadConflict: false }, callSettings: { newCallSlots: 3, totalCallCapacity: 5 },
    answers: [{ kind: 'requested_followup', accountId: 'a', draft, approval: null, capability: 'held', reason: 'requires_owner_preflight' }],
    meetings: [], campaigns: [], ownerStatus: [], transport: [], issues: [],
  });
}
function setup() {
  const baseline = leadDetailSchema.parse({
    personId: P, salesCycleId: C, personName: 'Kevin Shin', phones: [], emails: [], organizationLabel: 'Harbor Test Management', propertySummaries: [],
    stage: 'ready', workflowStatus: 'active', sourceLabel: 'custom', segment: 'warm', cloudScores: null, cloudLinked: false,
    findContactEligibility: { eligible: false, refusalReason: 'qualification_required' }, priorityContext: null, priorityReasons: [], nextAction: null,
    optedOut: false, cadence: null, outboundAttempts: [], activities: [], conversations: [], properties: [], history: [], revision: 1,
  });
  const calls: Parameters<typeof installApplicationModalScenario>[1] = [];
  const deny = (method: string) => async (): Promise<never> => { calls.push({ method, kind: 'forbidden' }); throw Error('baseline deny'); };
  const api: Parameters<typeof installApplicationModalScenario>[0] = {
    daily: { get: async () => { calls.push({ method: 'daily.get', kind: 'read', args: [] }); return nativeDaily(); } },
    leads: { list: deny('leads.list'), updateField: deny('leads.updateField'), bulkUpdate: deny('leads.bulkUpdate') },
    leadDetail: { get: deny('leadDetail.get'), beginOutbound: deny('leadDetail.beginOutbound'), getOutboundCapabilities: deny('leadDetail.getOutboundCapabilities'), confirmTransition: deny('leadDetail.confirmTransition'), dismissLead: deny('leadDetail.dismissLead'), overrideCloudScore: deny('leadDetail.overrideCloudScore'), findContactInfo: deny('leadDetail.findContactInfo') },
    conversations: { list: deny('conversations.list'), get: deny('conversations.get'), attachTranscript: deny('conversations.attachTranscript') },
    learnings: { list: deny('learnings.list'), capture: deny('learnings.capture'), addEvidence: deny('learnings.addEvidence'), updateStatus: deny('learnings.updateStatus') },
    imports: { preview: deny('imports.preview'), remap: deny('imports.remap'), commit: deny('imports.commit'), status: deny('imports.status') },
    friday: { getCurrent: deny('friday.getCurrent'), getDrilldown: deny('friday.getDrilldown'), createJob: deny('friday.createJob'), fillJob: deny('friday.fillJob'), cancelJob: deny('friday.cancelJob') },
    today: { get: deny('today.get'), getLeadTriageSnapshot: deny('today.getLeadTriageSnapshot'), complete: deny('today.complete'), snooze: deny('today.snooze'), pin: deny('today.pin'), logPastActivity: deny('today.logPastActivity'), addLeadNote: deny('today.addLeadNote'), logCallOutcome: deny('today.logCallOutcome'), markActivityInError: deny('today.markActivityInError'), getTriageQueue: deny('today.getTriageQueue'), setReviewPosition: deny('today.setReviewPosition') },
    discovery: { get: deny('discovery.get'), getBrief: deny('discovery.getBrief'), begin: deny('discovery.begin'), override: deny('discovery.override') },
    delegation: {
      status: deny('delegation.status'), policyImport: { selectAndPreview: deny('policyImport.selectAndPreview'), confirm: deny('policyImport.confirm'), resume: deny('policyImport.resume'), status: deny('policyImport.status') },
      prepareRequestedFollowup: deny('delegation.prepareRequestedFollowup'), getRequestedFollowup: deny('delegation.getRequestedFollowup'), editRequestedFollowup: deny('delegation.editRequestedFollowup'), approveRequestedFollowup: deny('delegation.approveRequestedFollowup'), getPhoneHandoffState: deny('delegation.getPhoneHandoffState'), beginPhone: deny('delegation.beginPhone'), bootstrap: deny('delegation.bootstrap'), configurePolicy: deny('delegation.configurePolicy'), configureResearch: deny('delegation.configureResearch'), pair: deny('delegation.pair'), configure: deny('delegation.configure'), submit: deny('delegation.submit'), sync: deny('delegation.sync'),
    },
  };
  const untouched = { status: api.imports.status, begin: api.discovery.begin, sync: api.delegation.sync, friday: api.friday };
  const installed = installApplicationModalScenario(api, calls, baseline);
  return { api: installed.api, calls, controller: installed.controller, baseline, untouched };
}

describe('finite synthetic modal fixture, pure contract tests', () => {
  it('only installs behind the exact opt-in before API exposure and preserves baseline source otherwise', () => {
    const entry = readFileSync(new URL('./applicationPresentationBrowser.tsx', import.meta.url), 'utf8');
    expect(entry).toContain("get('modalScenario') === '1'\n  ? installApplicationModalScenario(api, calls, detail, { fridayScenario: scenarioParams.get('fridayScenario') === '1' }) : undefined;");
    expect(entry.indexOf('? installApplicationModalScenario')).toBeLessThan(entry.indexOf('window.callie = modalScenario?.api ?? api'));
    expect(entry).toContain('...(modalScenario ? { modal: modalScenario.controller } : {})');
    const source = readFileSync(new URL('./applicationModalScenario.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*(renderer|main|applicationPresentationBrowser)/);
  });
  it('keeps every other method untouched and denies every unarmed finite method', async () => {
    const { api, calls, controller, untouched, baseline } = setup();
    expect(api.imports.status).toBe(untouched.status);
    expect(api.discovery.begin).toBe(untouched.begin);
    expect(api.delegation.sync).toBe(untouched.sync);
    expect(api.friday).toBe(untouched.friday);
    const attempts = [() => api.imports.preview(source), () => api.imports.remap({ previewId: 'x', contentHash: 'b'.repeat(64), mapping: { Name: 'person_name' } }),
      () => api.imports.commit(importCommitRequestSchema.parse({ previewId: 'x', contentHash: 'b'.repeat(64), mapping: { Name: 'person_name' }, source: { channel: 'custom', referredByPersonId: null }, duplicateDecisions: [] })),
      () => api.learnings.capture(capture), () => api.conversations.attachTranscript({ activityId: 'activity-call-kevin', personId: P, rawText: 'text' }),
      () => api.today.logPastActivity(manual), () => api.discovery.override(discovery), () => api.delegation.editRequestedFollowup({ accountId: 'a', draftId: 'draft-a', expectedRevision: 1, subject: 's', body: 'b' })];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow('forbids');
    expect(calls.map(call => call.method)).toEqual([...modalMethods]);
    expect(calls.every(call => call.kind === 'forbidden')).toBe(true);
    expect(controller.operations).toEqual([]);
    expect(baseline.stage).toBe('ready');
  });
  it('grants one budget, requires actual pending invocation and settles once', async () => {
    const { api, controller, calls } = setup();
    expect(() => controller.arm('imports.status' as ModalMethod)).toThrow();
    const token = controller.arm('learnings.capture');
    expect(() => controller.arm('learnings.capture')).toThrow('OUTSTANDING');
    expect(() => controller.settle(token, 'resolve')).toThrow('NOT_PENDING');
    const promise = api.learnings.capture(capture);
    expect(controller.operations[0]).toEqual({ token, method: 'learnings.capture', input: capture, state: 'pending' });
    expect(() => controller.arm('learnings.capture')).toThrow('OUTSTANDING');
    await expect(api.learnings.capture(capture)).rejects.toThrow('forbids');
    expect((await api.learnings.list(learningQuery)).rows).toEqual([]);
    const snapshot = controller.operations;
    snapshot[0].state = 'resolved';
    expect(controller.operations[0].state).toBe('pending');
    controller.settle(token, 'resolve');
    expect(await promise).toEqual({ revision: 2, affectedPersonIds: [], affectedSalesCycleIds: [] });
    expect(() => controller.settle(token, 'reject')).toThrow('NOT_PENDING');
    expect(() => controller.settle('unknown', 'resolve')).toThrow('NOT_PENDING');
    expect(calls.slice(0, 2).map(call => call.kind)).toEqual(['command', 'forbidden']);
    const list = await api.learnings.list(learningQuery);
    expect(list.rows[0].evidence.map(evidence => ({ quote: evidence.quote, notedAt: evidence.notedAt }))).toEqual(capture.evidence.map(({ quote, notedAt }) => ({ quote, notedAt })));
    expect(new Set(list.rows[0].evidence.map(evidence => evidence.id)).size).toBe(2);
    list.rows[0].statement = 'external mutation';
    expect((await api.learnings.list(learningQuery)).rows[0].statement).toBe(capture.statement);
  });
  it('strict input parsing consumes malformed attempts without a read-model update', async () => {
    const { api, controller } = setup();
    const token = controller.arm('learnings.capture');
    await expect(api.learnings.capture({ ...capture, unexpected: true } as typeof capture)).rejects.toThrow();
    expect(controller.operations[0].state).toBe('rejected');
    expect(() => controller.settle(token, 'resolve')).toThrow('NOT_PENDING');
    await expect(api.learnings.capture(capture)).rejects.toThrow('forbids');
    expect((await api.learnings.list(learningQuery)).rows).toEqual([]);
  });
  it('rejects without changes, permits explicit retry and preserves discovery replay IDs', async () => {
    const { api, controller } = setup();
    const before = await api.discovery.getBrief({ personId: P });
    const token = controller.arm('discovery.override');
    const rejected = api.discovery.override(discovery);
    const assertion = expect(rejected).rejects.toThrow('SYNTHETIC_RESPONSE_UNAVAILABLE');
    controller.settle(token, 'reject');
    await assertion;
    expect(await api.discovery.getBrief({ personId: P })).toEqual(before);
    const retry = controller.arm('discovery.override');
    const accepted = api.discovery.override(discovery);
    controller.settle(retry, 'resolve');
    expect(await accepted).toEqual({ revision: 2, affectedPersonIds: [P], affectedSalesCycleIds: [C] });
    expect(controller.operations[0].input).toEqual(controller.operations[1].input);
    expect((await api.discovery.getBrief({ personId: P })).latestOverride).toMatchObject({ reason: discovery.reason, decision: 'watch', assessmentId: discovery.assessmentId });
    await expect(api.discovery.getBrief({ personId: 'person-maya' })).rejects.toThrow();
  });
  it('binds transcript ownership, captures raw bytes and refreshes only the original conversation', async () => {
    const { api, controller, calls } = setup();
    const input = { activityId: 'activity-call-kevin', personId: P, rawText: 'me: Thanks for the call.\nKevin: Happy to discuss maintenance.' };
    const controlBefore = await api.conversations.get({ activityId: 'activity-call-maya' });
    const token = controller.arm('conversations.attachTranscript');
    const promise = api.conversations.attachTranscript(input);
    input.personId = 'person-maya';
    expect((await api.conversations.get({ activityId: 'activity-call-kevin' })).transcript).toBeNull();
    controller.settle(token, 'resolve');
    expect(await promise).toEqual({ revision: 2, affectedPersonIds: [P], affectedSalesCycleIds: [C] });
    expect(controller.operations[0].input).toMatchObject({ personId: P, rawText: input.rawText });
    expect(await api.conversations.get({ activityId: 'activity-call-maya' })).toEqual(controlBefore);
    const refreshed = await api.conversations.get({ activityId: 'activity-call-kevin' });
    expect(refreshed.transcript?.utterances.map(row => row.text)).toEqual(['Thanks for the call.', 'Happy to discuss maintenance.']);
    const list = await api.conversations.list({ query: '', filter: 'all', cursor: null, limit: 200 });
    expect(list.rows.map(row => row.transcriptAvailable)).toEqual([true, false]);
    expect(calls[0]).toEqual({ method: 'conversations.get', kind: 'read', args: [{ activityId: 'activity-call-maya' }] });
  });
  it('binds manual evidence to captured Kevin and leaves Maya unchanged', async () => {
    const { api, controller } = setup();
    const maya = await api.leadDetail.get({ personId: 'person-maya' });
    controller.arm('today.logPastActivity');
    await expect(api.today.logPastActivity({ ...manual, personId: 'person-maya' })).rejects.toThrow('MISMATCH');
    const token = controller.arm('today.logPastActivity');
    const input = structuredClone(manual);
    const promise = api.today.logPastActivity(input);
    input.personId = 'person-maya';
    expect((await api.leadDetail.get({ personId: P })).activities).toEqual([]);
    controller.settle(token, 'resolve');
    expect(await promise).toEqual({ revision: 2, affectedPersonIds: [P], affectedSalesCycleIds: [C] });
    expect(await api.leadDetail.get({ personId: 'person-maya' })).toEqual(maya);
    const kevin = await api.leadDetail.get({ personId: P });
    expect(kevin.stage).toBe('interviewed');
    expect(kevin.activities).toEqual([{ id: 'activity-manual-case-1', kind: 'call', occurredAt: manual.occurredAt, summary: manual.summary, outcome: 'price_said', markedInError: false }]);
    expect((await api.today.get()).revision).toBe(2);
  });
  it('acknowledges only the captured native draft after resolve and preserves daily read logging', async () => {
    const { api, controller, calls } = setup();
    const initial = await api.daily.get();
    const token = controller.arm('delegation.editRequestedFollowup');
    const input = { accountId: 'a', draftId: 'draft-a', expectedRevision: 1, subject: 'Edited subject', body: 'Edited body' };
    const rejected = api.delegation.editRequestedFollowup(input);
    const assertion = expect(rejected).rejects.toThrow('UNAVAILABLE');
    expect(await api.daily.get()).toEqual(initial);
    controller.settle(token, 'reject');
    await assertion;
    expect(await api.daily.get()).toEqual(initial);
    const retry = controller.arm('delegation.editRequestedFollowup');
    const accepted = api.delegation.editRequestedFollowup(input);
    input.accountId = 'b';
    controller.settle(retry, 'resolve');
    const response = await accepted;
    expect(response).toMatchObject({ draft: { accountId: 'a', id: 'draft-a', revision: 2, subject: 'Edited subject', body: 'Edited body' }, stale: false, approval: null });
    const next = await api.daily.get();
    expect(next.answers[0].kind).toBe('requested_followup');
    if (next.answers[0].kind !== 'requested_followup') throw Error('wrong answer');
    expect(next.answers[0].draft).toEqual(response.draft);
    expect(calls.filter(call => call.method === 'daily.get')).toEqual(Array.from({ length: 4 }, () => ({ method: 'daily.get', kind: 'read', args: [] as unknown[] })));
  });
  it('rejects exactly the next actual Today read without changing records, logs or pending manual ownership', async () => {
    const { api, controller, calls } = setup();
    const before = await api.today.get();
    const detail = await api.leadDetail.get({ personId: P });
    const token = controller.arm('today.logPastActivity');
    const save = api.today.logPastActivity(manual);
    const pending = controller.operations;
    const checkpoint = structuredClone(calls);
    controller.rejectNextRead('today.get');
    expect(calls).toEqual(checkpoint);
    expect(controller.operations).toEqual(pending);
    expect(() => controller.rejectNextRead('today.get')).toThrow('SYNTHETIC_READ_FAILURE_OUTSTANDING');
    await expect(api.today.get()).rejects.toThrow('SYNTHETIC_READ_UNAVAILABLE');
    expect(calls.slice(checkpoint.length)).toEqual([{ method: 'today.get', kind: 'read', args: [] }]);
    expect(controller.operations).toEqual(pending);
    expect(await api.today.get()).toEqual(before);
    expect(await api.leadDetail.get({ personId: P })).toEqual(detail);
    controller.rejectNextRead('today.get');
    await expect(api.today.get()).rejects.toThrow('SYNTHETIC_READ_UNAVAILABLE');
    expect(await api.today.get()).toEqual(before);
    controller.settle(token, 'resolve');
    expect(await save).toEqual({ revision: 2, affectedPersonIds: [P], affectedSalesCycleIds: [C] });
    expect((await api.today.get()).revision).toBe(2);
    expect((await api.leadDetail.get({ personId: P })).activities).toHaveLength(1);
  });
  it('refuses other read methods without spending or widening the Today-only allowance', async () => {
    const { api, controller, calls } = setup();
    expect(() => controller.rejectNextRead('leadDetail.get' as 'today.get')).toThrow('SYNTHETIC_CASE_INPUT_MISMATCH');
    expect(calls).toEqual([]);
    expect(controller.operations).toEqual([]);
    const before = await api.today.get();
    controller.rejectNextRead('today.get');
    await api.leadDetail.get({ personId: P });
    expect(() => controller.rejectNextRead('discovery.getBrief' as 'today.get')).toThrow('SYNTHETIC_CASE_INPUT_MISMATCH');
    await expect(api.today.get()).rejects.toThrow('SYNTHETIC_READ_UNAVAILABLE');
    expect(await api.today.get()).toEqual(before);
    expect(modalMethods).toHaveLength(8);
  });
  it('requires accepted preview identity, supports remap and refreshes Leads only after accepted commit', async () => {
    const { api, controller } = setup();
    let token = controller.arm('imports.preview');
    const previewPromise = api.imports.preview(source);
    controller.settle(token, 'resolve');
    const preview = await previewPromise;
    token = controller.arm('imports.remap');
    const remapPromise = api.imports.remap({ previewId: preview.previewId, contentHash: preview.contentHash, mapping: { Name: 'person_name', Email: 'ignore' } });
    controller.settle(token, 'resolve');
    const remapped = await remapPromise;
    expect(remapped.suggestedMapping.Email).toBe('ignore');
    const input = importCommitRequestSchema.parse({ previewId: preview.previewId, contentHash: preview.contentHash, mapping: remapped.suggestedMapping, source: { channel: 'custom', referredByPersonId: null }, duplicateDecisions: [] });
    token = controller.arm('imports.commit');
    const rejected = api.imports.commit(input);
    const assertion = expect(rejected).rejects.toThrow('UNAVAILABLE');
    controller.settle(token, 'reject');
    await assertion;
    expect((await api.leads.list(leadQuery)).total).toBe(2);
    token = controller.arm('imports.commit');
    const commit = api.imports.commit(input);
    expect((await api.leads.list(leadQuery)).total).toBe(2);
    controller.settle(token, 'resolve');
    expect(await commit).toEqual({ jobId: 'import-case-1', importedPersonIds: ['person-imported-case-1'], importedRowCount: 1, revision: 2 });
    expect((await api.leads.list(leadQuery)).rows[2].personName).toBe('Alex Example');
    await expect(api.imports.status({ jobId: 'import-case-1' })).rejects.toThrow('baseline deny');
  });
});
