import { describe, expect, it } from 'vitest';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { leadDetailSchema } from '../../src/shared/contracts/leadDetailContract';
import { leadsListResponseSchema, type LeadsListRequest } from '../../src/shared/contracts/leadsContract';
import { mutationReceiptSchema } from '../../src/shared/contracts/commonContract';
import { discoveryBriefSchema, type DiscoveryBrief } from '../../src/shared/contracts/discoveryContract';
import { installApplicationLeadsScenario } from './applicationLeadsScenario';
const list: LeadsListRequest = { query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 200 };
const P = 'person-leads-001', Q = 'person-leads-208';
const baseline = leadDetailSchema.parse({
  personId: 'baseline', salesCycleId: 'cycle-baseline', personName: 'Baseline', phones: [], emails: [],
  organizationLabel: null, propertySummaries: [], stage: 'ready', workflowStatus: 'active', sourceLabel: 'custom',
  segment: 'warm', priorityContext: null, cloudScores: null, cloudLinked: false,
  findContactEligibility: { eligible: false, refusalReason: 'qualification_required' }, priorityReasons: [], nextAction: null,
  optedOut: false, cadence: null, activities: [], conversations: [], outboundAttempts: [], properties: [], history: [], revision: 1,
});
function setup() {
  const denied = async (): Promise<never> => { throw Error('BASE_DENIED'); };
  const original: Pick<CalliePreloadApi, 'leads' | 'leadDetail' | 'discovery'> = {
    leads: { list: denied, updateField: denied, bulkUpdate: denied },
    leadDetail: { get: denied, beginOutbound: denied, getOutboundCapabilities: denied, confirmTransition: denied,
      dismissLead: denied, overrideCloudScore: denied, findContactInfo: denied },
    discovery: { get: denied, getBrief: denied, begin: denied, override: denied },
  };
  const calls: Array<{ method: string; kind: 'read' | 'command' | 'forbidden'; args?: unknown[] }> = [];
  return { ...installApplicationLeadsScenario(original, calls, baseline), calls, original };
}
describe('finite actual-app Leads scenario', () => {
  it('reads only the exact known discovery owner with strict cloned output and no new deferred-read capability', async () => {
    const { api, calls, controller, original } = setup();
    const expected: DiscoveryBrief = { personId: Q, salesCycleId: 'cycle-leads-208', personName: 'Test Lead 208', assessment: null, stale: false, latestOverride: null, pilotNextStep: null };
    const value = discoveryBriefSchema.parse(await api.discovery.getBrief({ personId: Q }));
    expect(value).toEqual(expected); value.personName = 'Changed inspection';
    expect(await api.discovery.getBrief({ personId: Q })).toEqual(expected);
    await expect(api.discovery.getBrief({ personId: 'unknown' })).rejects.toThrow();
    await expect(api.discovery.getBrief({ personId: ' ' })).rejects.toThrow();
    expect(calls).toEqual([Q, Q, 'unknown', ' '].map(personId => ({ method: 'discovery.getBrief', kind: 'read', args: [{ personId }] })));
    expect(api.discovery.begin).toBe(original.discovery.begin); expect(api.discovery.override).toBe(original.discovery.override);
    await expect(original.discovery.getBrief({ personId: Q })).rejects.toThrow('BASE_DENIED');
    expect(() => Reflect.apply(controller.deferNextRead, controller, ['discovery.getBrief'])).toThrow();
    expect(controller.operations).toEqual([]);
  });
  it('rejects an out-of-scope schema-valid dismissal reason without changing the selected person', async () => {
    const { api, controller } = setup(); const before = await api.leads.list(list);
    const token = controller.arm('leadDetail.dismissLead');
    const result = api.leadDetail.dismissLead({ personId: P, salesCycleId: 'cycle-leads-001', expectedRevision: 1, qualificationGateReason: 'no_relevant_decision_relationship' });
    const outcome = result.then(() => 'resolved', () => 'rejected');
    // A broader implementation incorrectly accepts this schema-valid request. Settle it to expose that behavior without a hanging test.
    if (controller.operations.find(op => op.token === token)?.state === 'pending') controller.settle(token, 'resolve');
    expect(await outcome).toBe('rejected');
    expect(controller.operations.find(op => op.token === token)?.state).toBe('rejected');
    expect(await api.leads.list(list)).toEqual(before);
  });
  it('provides 208 strict rows through opaque query-bound continuation without mutating the base API', async () => {
    const { api, original, calls } = setup();
    const first = leadsListResponseSchema.parse(await api.leads.list(list));
    expect(first.rows).toHaveLength(200); expect(first.total).toBe(208); expect(first.nextCursor).toEqual(expect.any(String));
    const next = { ...list, cursor: first.nextCursor };
    const last = leadsListResponseSchema.parse(await api.leads.list(next));
    expect(last.rows).toHaveLength(8); expect(last.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...last.rows].map(row => row.personId)).size).toBe(208);
    expect(last.rows.at(-1)?.personId).toBe(Q);
    expect(calls).toEqual([{ method: 'leads.list', kind: 'read', args: [list] }, { method: 'leads.list', kind: 'read', args: [next] }]);
    expect(api.leads).not.toBe(original.leads); await expect(original.leads.list(list)).rejects.toThrow('BASE_DENIED');
  });
  it('applies actual query and stage filters before paging and refuses unknown or query-mismatched cursors', async () => {
    const { api } = setup(); const first = await api.leads.list(list);
    const query = { ...list, query: 'Test Lead 001', sort: 'person_name' as const };
    expect((await api.leads.list(query)).rows.map(row => row.personId)).toEqual([P]);
    expect((await api.leads.list({ ...list, stages: ['ready'] })).total).toBe(0);
    await expect(api.leads.list({ ...query, cursor: first.nextCursor })).rejects.toThrow();
    await expect(api.leads.list({ ...list, cursor: '200' })).rejects.toThrow();
  });
  it('defaults to denied writes and preserves unrelated API members', async () => {
    const { api, calls, original } = setup();
    await expect(api.leads.updateField({ personId: P, field: 'person_name', value: 'Renamed' })).rejects.toThrow('FORBIDDEN');
    expect(calls[0]).toMatchObject({ method: 'leads.updateField', kind: 'forbidden' });
    expect((await api.leadDetail.get({ personId: P })).personName).toBe('Test Lead 001');
    expect(api.leadDetail.beginOutbound).toBe(original.leadDetail.beginOutbound);
  });
  it('consumes malformed armed attempts and rejects unsupported methods and duplicate arms', async () => {
    const { api, controller } = setup(); const token = controller.arm('leads.updateField');
    expect(() => controller.arm('leads.updateField')).toThrow();
    expect(() => Reflect.apply(controller.arm, controller, ['imports.commit'])).toThrow();
    await expect(api.leads.updateField({ personId: P, field: 'person_name', value: '' })).rejects.toThrow();
    expect(controller.operations.find(op => op.token === token)?.state).toBe('rejected');
    expect(() => controller.settle(token, 'resolve')).toThrow();
    await expect(api.leads.updateField({ personId: P, field: 'person_name', value: 'Name' })).rejects.toThrow('FORBIDDEN');
  });
  it('captures exact inputs, fulfills once, detaches inspection snapshots and invalidates previous cursors', async () => {
    const { api, controller } = setup(); const first = await api.leads.list(list);
    const token = controller.arm('leads.updateField');
    const input = { personId: P, field: 'person_name' as const, value: 'Renamed Lead' };
    const promise = api.leads.updateField(input); input.value = 'Changed caller';
    const snapshot = controller.operations; snapshot[0].state = 'rejected';
    expect(controller.operations[0]).toMatchObject({ state: 'pending', input: { ...input, value: 'Renamed Lead' } });
    expect((await api.leadDetail.get({ personId: P })).personName).toBe('Test Lead 001');
    controller.settle(token, 'resolve');
    expect(mutationReceiptSchema.parse(await promise)).toEqual({ revision: 2, affectedPersonIds: [P], affectedSalesCycleIds: ['cycle-leads-001'] });
    expect((await api.leadDetail.get({ personId: P })).personName).toBe('Renamed Lead');
    expect(() => controller.settle(token, 'resolve')).toThrow();
    await expect(api.leads.list({ ...list, cursor: first.nextCursor })).rejects.toThrow('STALE');
  });
  it('rejected writes preserve every synthetic row and require a new explicit allowance', async () => {
    const { api, controller } = setup(); const before = await api.leads.list(list);
    const token = controller.arm('leads.updateField');
    const result = api.leads.updateField({ personId: P, field: 'organization_label', value: null });
    const rejected = expect(result).rejects.toThrow('SYNTHETIC_COMMAND_REJECTED');
    controller.settle(token, 'reject'); await rejected;
    expect(await api.leads.list(list)).toEqual(before);
    const retry = controller.arm('leads.updateField');
    const saved = api.leads.updateField({ personId: P, field: 'organization_label', value: null });
    controller.settle(retry, 'resolve'); await saved;
    expect((await api.leadDetail.get({ personId: P })).organizationLabel).toBeNull();
  });
  it('bulk fulfillment changes exactly both captured people despite one being outside the current filter', async () => {
    const { api, controller } = setup();
    await api.leads.list({ ...list, query: 'Test Lead 001' });
    const token = controller.arm('leads.bulkUpdate');
    const result = api.leads.bulkUpdate({ personIds: [P, Q], field: 'organization_label', value: 'Shared Test Company' });
    controller.settle(token, 'resolve'); expect((await result).affectedPersonIds).toEqual([P, Q]);
    expect((await api.leadDetail.get({ personId: P })).organizationLabel).toBe('Shared Test Company');
    expect((await api.leadDetail.get({ personId: Q })).organizationLabel).toBe('Shared Test Company');
    expect((await api.leadDetail.get({ personId: 'person-leads-002' })).organizationLabel).toBe('Fixture Company 002');
  });
  it('rejects duplicate, oversized, unknown and unsupported bulk requests before changing records', async () => {
    const { api, controller } = setup(); const before = await api.leads.list(list);
    for (const input of [
      { personIds: [P, P], field: 'organization_label' as const, value: 'X' },
      { personIds: Array.from({ length: 201 }, (_, i) => `person-leads-${String(i + 1).padStart(3, '0')}`), field: 'organization_label' as const, value: 'X' },
      { personIds: ['unknown'], field: 'organization_label' as const, value: 'X' },
      { personIds: [P], field: 'person_name' as const, value: 'X' },
    ]) { controller.arm('leads.bulkUpdate'); await expect(api.leads.bulkUpdate(input)).rejects.toThrow(); }
    expect(await api.leads.list(list)).toEqual(before);
  });
  it('captures deferred list and detail snapshots at invocation and logs only actual reads', async () => {
    const { api, controller, calls } = setup(); const read = controller.deferNextRead('leads.list');
    expect(calls).toHaveLength(0); expect(() => controller.deferNextRead('leads.list')).toThrow();
    const old = api.leads.list(list); const detail = controller.deferNextRead('leadDetail.get');
    const oldDetail = api.leadDetail.get({ personId: P });
    const edit = controller.arm('leads.updateField'); const result = api.leads.updateField({ personId: P, field: 'person_name', value: 'Renamed Lead' });
    controller.settle(edit, 'resolve'); await result;
    expect((await api.leads.list(list)).rows[0].personName).toBe('Renamed Lead');
    controller.settle(read, 'resolve'); controller.settle(detail, 'resolve');
    expect((await old).rows[0].personName).toBe('Test Lead 001'); expect((await oldDetail).personName).toBe('Test Lead 001');
  });
  it('rejects a deferred read once without mutating the model or intercepting later reads', async () => {
    const { api, controller } = setup(); const token = controller.deferNextRead('leads.list');
    expect(() => controller.settle(token, 'resolve')).toThrow();
    const result = api.leads.list(list); const rejected = expect(result).rejects.toThrow('SYNTHETIC_READ_REJECTED');
    controller.settle(token, 'reject'); await rejected;
    expect((await api.leads.list(list)).total).toBe(208); expect(() => controller.settle(token, 'reject')).toThrow();
  });
  it('binds ready and dismiss requests to their exact cycle/person/revision and updates only on fulfillment', async () => {
    const { api, controller } = setup();
    const token = controller.arm('leadDetail.confirmTransition');
    const ready = api.leadDetail.confirmTransition({ transition: 'review_to_ready', salesCycleId: 'cycle-leads-001', expectedRevision: 1 });
    expect((await api.leadDetail.get({ personId: P })).stage).toBe('unreviewed');
    controller.settle(token, 'resolve'); expect((await ready).affectedPersonIds).toEqual([P]);
    expect((await api.leads.list({ ...list, stages: ['ready'] })).rows.map(row => row.personId)).toEqual([P]);
    const bad = controller.arm('leadDetail.dismissLead');
    await expect(api.leadDetail.dismissLead({ personId: P, salesCycleId: 'cycle-leads-208', expectedRevision: 2, qualificationGateReason: 'out_of_area' })).rejects.toThrow();
    expect(controller.operations.find(op => op.token === bad)?.state).toBe('rejected');
    const dismiss = controller.arm('leadDetail.dismissLead');
    const done = api.leadDetail.dismissLead({ personId: P, salesCycleId: 'cycle-leads-001', expectedRevision: 2, qualificationGateReason: 'out_of_area' });
    controller.settle(dismiss, 'resolve'); await done;
    expect((await api.leads.list(list)).total).toBe(207);
    expect(await api.leadDetail.get({ personId: P })).toMatchObject({ stage: 'lost_nurture', workflowStatus: 'closed' });
  });
});
