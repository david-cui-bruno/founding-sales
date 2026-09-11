/** Test-only finite Leads scenario. No renderer, native, database or network imports. */
import type { CalliePreloadApi } from '../../src/shared/preload';
import { mutationReceiptSchema } from '../../src/shared/contracts/commonContract';
import { discoveryBriefRequestSchema, discoveryBriefSchema } from '../../src/shared/contracts/discoveryContract';
import { confirmTransitionRequestSchema, dismissLeadRequestSchema, leadDetailRequestSchema, leadDetailSchema, type LeadDetail } from '../../src/shared/contracts/leadDetailContract';
import { leadBulkUpdateRequestSchema, leadFieldUpdateRequestSchema, leadRowSchema, leadsListRequestSchema, leadsListResponseSchema, type LeadRow } from '../../src/shared/contracts/leadsContract';
export const leadsCommands = ['leads.updateField', 'leads.bulkUpdate', 'leadDetail.confirmTransition', 'leadDetail.dismissLead'] as const;
export type LeadsCommand = typeof leadsCommands[number];
export const leadsReads = ['leads.list', 'leadDetail.get'] as const;
export type LeadsRead = typeof leadsReads[number];
export type LeadsOperation = { token: string; kind: 'command' | 'read'; method: LeadsCommand | LeadsRead; input: unknown; state: 'armed' | 'pending' | 'resolved' | 'rejected' };
export interface LeadsController {
  arm(method: LeadsCommand): string;
  deferNextRead(method: LeadsRead): string;
  settle(token: string, outcome: 'resolve' | 'reject'): void;
  readonly operations: LeadsOperation[];
}
type ScenarioApi = Pick<CalliePreloadApi, 'leads' | 'leadDetail' | 'discovery'>;
type CallSink = Array<{ method: string; kind: 'read' | 'command' | 'forbidden'; args?: unknown[] }>;
function requireCase(condition: boolean, message = 'SYNTHETIC_CASE_INPUT_MISMATCH'): asserts condition {
  if (!condition) throw Error(message);
}
export function installApplicationLeadsScenario<A extends ScenarioApi>(original: A, calls: CallSink, baseline: LeadDetail): { api: A; controller: LeadsController } {
  const rows = new Map<string, LeadRow>();
  const details = new Map<string, LeadDetail>();
  for (let n = 1; n <= 208; n++) {
    const suffix = String(n).padStart(3, '0');
    const detail = leadDetailSchema.parse({ ...baseline, personId: `person-leads-${suffix}`, salesCycleId: `cycle-leads-${suffix}`,
      personName: `Test Lead ${suffix}`, organizationLabel: `Fixture Company ${suffix}`, stage: 'unreviewed', revision: 1 });
    details.set(detail.personId, detail);
    rows.set(detail.personId, leadRowSchema.parse({ personId: detail.personId, salesCycleId: detail.salesCycleId, personName: detail.personName,
      initials: 'TL', organization: detail.organizationLabel, propertySummary: null, stage: 'unreviewed', source: 'custom', segment: 'warm',
      priorityContext: null, cloudScores: null, nextAction: null, optedOut: false, lastActivityAt: null }));
  }
  let revision = 1, sequence = 0;
  const cursors = new Map<string, { key: string; revision: number; index: number }>();
  const cursorKeys = new Map<string, string>();
  const operations: LeadsOperation[] = [];
  const pending = new Map<string, (outcome: 'resolve' | 'reject') => void>();
  const getDetail = (id: string) => {
    const detail = details.get(id); requireCase(detail !== undefined); return detail;
  };
  const getRow = (id: string) => { const row = rows.get(id); requireCase(row !== undefined); return row; };
  function begin(kind: LeadsOperation['kind'], method: LeadsCommand | LeadsRead) {
    requireCase(!operations.some(op => op.method === method && (op.state === 'armed' || (kind === 'command' && op.state === 'pending'))), 'SYNTHETIC_ALREADY_ARMED');
    const token = `leads-operation-${++sequence}`;
    operations.push({ token, kind, method, input: null, state: 'armed' });
    return token;
  }
  const controller: LeadsController = {
    arm(method) { requireCase(leadsCommands.some(value => value === method)); return begin('command', method); },
    deferNextRead(method) { requireCase(leadsReads.some(value => value === method)); return begin('read', method); },
    settle(token, outcome) {
      requireCase(outcome === 'resolve' || outcome === 'reject');
      const fulfill = pending.get(token); requireCase(fulfill !== undefined, 'SYNTHETIC_NOT_PENDING');
      pending.delete(token); fulfill(outcome);
    },
    get operations() { return structuredClone(operations); },
  };
  const invoke = async <I, O>(kind: LeadsOperation['kind'], method: LeadsCommand | LeadsRead, input: I, prepare: (captured: I) => () => O): Promise<O> => {
    const captured = structuredClone(input);
    const operation = operations.find(op => op.method === method && op.state === 'armed');
    if (kind === 'command' && !operation) {
      calls.push({ kind: 'forbidden', method, args: [captured] });
      throw Error('SYNTHETIC_FORBIDDEN_COMMAND');
    }
    calls.push({ kind, method, args: [structuredClone(captured)] });
    if (operation) { operation.input = structuredClone(captured); operation.state = 'pending'; }
    let effect: () => O;
    try { effect = prepare(captured); }
    catch (error) { if (operation) operation.state = 'rejected'; throw error; }
    if (!operation) return structuredClone(effect());
    return new Promise<O>((resolve, reject) => {
      pending.set(operation.token, outcome => {
        if (outcome === 'reject') {
          operation.state = 'rejected'; reject(Error(kind === 'read' ? 'SYNTHETIC_READ_REJECTED' : 'SYNTHETIC_COMMAND_REJECTED')); return;
        }
        try { const value = structuredClone(effect()); operation.state = 'resolved'; resolve(value); }
        catch (error) { operation.state = 'rejected'; reject(error); }
      });
    });
  };
  const receipt = (ids: string[]) => mutationReceiptSchema.parse({ revision, affectedPersonIds: ids,
    affectedSalesCycleIds: ids.map(id => getDetail(id).salesCycleId) });
  const api: A = {
    ...original,
    discovery: {
      ...original.discovery,
      getBrief: async input => {
        const captured = structuredClone(input);
        calls.push({ method: 'discovery.getBrief', kind: 'read', args: [captured] });
        const request = discoveryBriefRequestSchema.parse(captured), detail = getDetail(request.personId);
        return discoveryBriefSchema.parse({ personId: detail.personId, salesCycleId: detail.salesCycleId, personName: detail.personName,
          assessment: null, stale: false, latestOverride: null, pilotNextStep: null });
      },
    },
    leads: {
      ...original.leads,
      list: input => invoke('read', 'leads.list', input, captured => {
        const request = leadsListRequestSchema.parse(captured);
        const { cursor, ...controls } = request;
        const key = JSON.stringify(controls);
        let index = 0;
        if (cursor !== null) {
          const position = cursors.get(cursor); requireCase(position !== undefined, 'SYNTHETIC_CURSOR_UNKNOWN');
          requireCase(position.key === key, 'SYNTHETIC_CURSOR_QUERY_MISMATCH');
          requireCase(position.revision === revision, 'SYNTHETIC_CURSOR_STALE'); index = position.index;
        }
        const query = request.query.toLowerCase();
        const selected = [...rows.values()].filter(row => (!query || `${row.personName} ${row.organization ?? ''}`.toLowerCase().includes(query))
          && (!request.stages.length || request.stages.includes(row.stage))
          && (!request.priorities.length || (row.priorityContext !== null && request.priorities.includes(row.priorityContext.priority))));
        selected.sort((a, b) => request.sort === 'person_name'
          ? a.personName.localeCompare(b.personName) || a.personId.localeCompare(b.personId)
          : a.personId.localeCompare(b.personId));
        const end = index + request.limit;
        let nextCursor: string | null = null;
        if (end < selected.length) {
          const cursorKey = JSON.stringify([key, revision, end]);
          nextCursor = cursorKeys.get(cursorKey) ?? `fixture-window-${++sequence}`;
          cursorKeys.set(cursorKey, nextCursor); cursors.set(nextCursor, { key, revision, index: end });
        }
        const snapshot = leadsListResponseSchema.parse(structuredClone({ rows: selected.slice(index, end), nextCursor, total: selected.length, revision }));
        return () => snapshot;
      }),
      updateField: input => invoke('command', 'leads.updateField', input, captured => {
        const request = leadFieldUpdateRequestSchema.parse(captured); getRow(request.personId); getDetail(request.personId);
        return () => {
          const row = getRow(request.personId), detail = getDetail(request.personId); revision++;
          if (request.field === 'person_name') { row.personName = request.value; detail.personName = request.value; }
          else { row.organization = request.value; detail.organizationLabel = request.value; }
          detail.revision = revision;
          return receipt([request.personId]);
        };
      }),
      bulkUpdate: input => invoke('command', 'leads.bulkUpdate', input, captured => {
        const request = leadBulkUpdateRequestSchema.parse(captured);
        requireCase(request.field === 'organization_label' && new Set(request.personIds).size === request.personIds.length);
        for (const id of request.personIds) { getRow(id); getDetail(id); }
        return () => {
          // Validate the whole captured set before changing any synthetic record.
          const owners = request.personIds.map(id => ({ row: getRow(id), detail: getDetail(id) })); revision++;
          for (const { row, detail } of owners) { row.organization = request.value; detail.organizationLabel = request.value; detail.revision = revision; }
          return receipt(request.personIds);
        };
      }),
    },
    leadDetail: {
      ...original.leadDetail,
      get: input => invoke('read', 'leadDetail.get', input, captured => {
        const request = leadDetailRequestSchema.parse(captured);
        const snapshot = leadDetailSchema.parse(structuredClone(getDetail(request.personId)));
        return () => snapshot;
      }),
      confirmTransition: input => invoke('command', 'leadDetail.confirmTransition', input, captured => {
        const request = confirmTransitionRequestSchema.parse(captured); requireCase(request.transition === 'review_to_ready');
        const detail = [...details.values()].find(item => item.salesCycleId === request.salesCycleId);
        requireCase(detail !== undefined && detail.revision === request.expectedRevision && detail.stage === 'unreviewed');
        const id = detail.personId;
        return () => {
          const current = getDetail(id); requireCase(current.revision === request.expectedRevision && current.stage === 'unreviewed');
          const row = getRow(id); revision++; current.stage = 'ready'; current.revision = revision; row.stage = 'ready';
          return receipt([id]);
        };
      }),
      dismissLead: input => invoke('command', 'leadDetail.dismissLead', input, captured => {
        const request = dismissLeadRequestSchema.parse(captured), detail = getDetail(request.personId); getRow(request.personId);
        requireCase(request.qualificationGateReason === 'out_of_area');
        requireCase(detail.salesCycleId === request.salesCycleId && detail.revision === request.expectedRevision);
        return () => {
          const current = getDetail(request.personId); getRow(request.personId);
          requireCase(current.salesCycleId === request.salesCycleId && current.revision === request.expectedRevision);
          revision++; rows.delete(request.personId); current.stage = 'lost_nurture'; current.workflowStatus = 'closed'; current.revision = revision;
          return receipt([request.personId]);
        };
      }),
    },
  };
  return { api, controller };
}
