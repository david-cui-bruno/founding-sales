/** Test-only, finite synthetic API scenario. No renderer, provider, native or network imports. */
import type { CalliePreloadApi } from '../../src/shared/preload';
import { fridayReportSchema, fridayReportRequestSchema, jobRequestSchema, createJobRequestSchema, fillJobRequestSchema, cancelJobRequestSchema } from '../../src/shared/contracts/fridayContract';
import { mutationReceiptSchema } from '../../src/shared/contracts/commonContract';
import { leadDetailRequestSchema, leadDetailSchema, type LeadDetail } from '../../src/shared/contracts/leadDetailContract';
import { leadRowSchema, leadsListRequestSchema, leadsListResponseSchema } from '../../src/shared/contracts/leadsContract';
import { conversationRowSchema, conversationDetailSchema, conversationDetailRequestSchema, conversationsListRequestSchema, conversationsListResponseSchema, attachTranscriptRequestSchema } from '../../src/shared/contracts/conversationsContract';
import { captureLearningRequestSchema, learningRowSchema, learningsListRequestSchema, learningsListResponseSchema } from '../../src/shared/contracts/learningsContract';
import { importSourceSchema, importPreviewSchema, importRemapRequestSchema, importCommitRequestSchema, importCommitReceiptSchema } from '../../src/shared/contracts/importContract';
import { todaySnapshotSchema, todayItemSchema, logPastActivityRequestSchema } from '../../src/shared/contracts/todayContract';
import { discoveryBriefRequestSchema, discoveryBriefSchema, overrideDiscoveryRequestSchema } from '../../src/shared/contracts/discoveryContract';
import { dailySnapshotSchema } from '../../src/shared/contracts/dailyContract';
import { editRequestedFollowupSchema, savedRequestedFollowupSchema, type RequestedFollowupDraft } from '../../src/shared/contracts/requestedFollowupContract';

export const modalMethods = ['imports.preview', 'imports.remap', 'imports.commit', 'learnings.capture', 'conversations.attachTranscript', 'today.logPastActivity', 'discovery.override', 'delegation.editRequestedFollowup'] as const;
export const fridayModalMethods = ['friday.createJob', 'friday.fillJob', 'friday.cancelJob'] as const;
export type ModalMethod = typeof modalMethods[number] | typeof fridayModalMethods[number];
export type ModalOperation = { token: string; method: ModalMethod; input: unknown; state: 'armed' | 'pending' | 'resolved' | 'rejected' };
export interface ModalController {
  arm(method: ModalMethod): string;
  rejectNextRead(method: 'today.get' | 'friday.getCurrent'): void;
  settle(token: string, outcome: 'resolve' | 'reject'): void;
  readonly operations: ModalOperation[];
}
type CallSink = Array<{ method: string; kind: 'read' | 'command' | 'forbidden'; args?: unknown[] }>;
type ScenarioApi = Pick<CalliePreloadApi, 'leads' | 'leadDetail' | 'conversations' | 'learnings' | 'today' | 'discovery' | 'imports' | 'delegation' | 'daily' | 'friday'>;
const T = '2026-09-10T12:00:00.000Z';
const P = 'person-kevin';
const C = 'cycle-kevin';
const Q = 'person-maya';
const D = 'cycle-maya';
const sourceText = 'Name,Email\nAlex Example,alex@example.test';
function requireCase(condition: boolean): asserts condition {
  if (!condition) throw Error('SYNTHETIC_CASE_INPUT_MISMATCH');
}

export function installApplicationModalScenario<A extends ScenarioApi>(api: A, calls: CallSink, baseline: LeadDetail, options: { fridayScenario?: boolean } = {}) {
  const fridayScenario = options.fridayScenario === true;
  const details = new Map([
    [P, leadDetailSchema.parse({ ...baseline, stage: 'interviewed' })],
    [Q, leadDetailSchema.parse({ ...baseline, personId: Q, salesCycleId: D, personName: 'Maya Ortiz', organizationLabel: 'Orchard Test Management', stage: 'interviewed' })],
  ]);
  const rows = [...details.values()].map(detail => leadRowSchema.parse({
    personId: detail.personId, salesCycleId: detail.salesCycleId, personName: detail.personName,
    initials: detail.personId === P ? 'KS' : 'MO', organization: detail.organizationLabel, propertySummary: null,
    stage: 'interviewed', source: 'custom', segment: 'warm', priorityContext: null, cloudScores: null,
    nextAction: null, optedOut: false, lastActivityAt: null,
  }));
  let leadsRevision = 1;
  const conversations = new Map([P, Q].map(personId => {
    const kevin = personId === P;
    const row = conversationRowSchema.parse({
      activityId: kevin ? 'activity-call-kevin' : 'activity-call-maya', personId, salesCycleId: kevin ? C : D,
      personName: kevin ? 'Kevin Shin' : 'Maya Ortiz', kind: 'call', direction: 'outbound',
      occurredAt: '2026-09-09T16:00:00.000Z', durationSeconds: 480, recordingAvailable: false,
      transcriptAvailable: false, summary: 'Synthetic maintenance workflow conversation',
    });
    return [row.activityId, conversationDetailSchema.parse({ ...row, transcript: null })];
  }));
  let conversationsRevision = 1;
  let learnings = learningsListResponseSchema.parse({ rows: [], totalActiveCount: 0, revision: 1 });
  let today = todaySnapshotSchema.parse({
    lanes: [{ id: 'due_cadence', items: [todayItemSchema.parse({
      id: C, lane: 'due_cadence', personId: P, salesCycleId: C, personName: 'Kevin Shin', contextLabel: 'Harbor Test Management',
      stage: 'interviewed', priorityContext: null, action: { id: 'action-kevin', type: 'call_lead', channel: 'call', label: 'Call', dueAt: null },
      reason: 'callback_promised_today', activeTriggers: [], verifyFirst: false, pinned: false, consentRequirement: null, cloudScores: null,
    })], overflowCount: 0 }], dialBudget: 40, scheduledDials: 1, conversationTarget: 4, reviewErrorCount: 0,
    revision: 1, unreviewedBacklogCount: 0, unreviewedCloudSignalCount: 0, conversationsHeld: 0,
  });
  let brief = discoveryBriefSchema.parse({
    personId: P, salesCycleId: C, personName: 'Kevin Shin', stale: false, latestOverride: null, pilotNextStep: null,
    assessment: {
      id: '10000000-0000-4000-8000-000000000001', personId: P, prospectId: 'prospect-kevin', salesCycleId: C,
      fingerprint: 'a'.repeat(64), policyVersion: 'discovery-v1', ruleVersionId: 'rules-case', modelVersion: null,
      evaluatedAt: T, expiresAt: '2026-09-11T12:00:00.000Z', localDate: '2026-09-10', overrideId: null,
      disposition: 'research', reasonCodes: ['unknown_owner'], axes: { fit: null, timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' },
      claims: [{ id: 'address-fact', label: 'Address', value: 'Synthetic address', certainty: 'fact', refs: [{ kind: 'source', sourceEventId: 'source-case', field: 'address', observedAt: '2026-09-10T11:00:00.000Z' }] }],
      unknowns: ['Owner identity is not established'], questions: ['Who handles maintenance?'], identitySupported: false, needsResearch: true,
      ranking: { priority: null, earliestTriggerExpiresAt: null, dataConfidence: 0, lastContactAt: null, latestSourceObservedAt: null },
    },
  });
  let preview = importPreviewSchema.parse({
    previewId: 'preview-case-1', contentHash: 'b'.repeat(64), columns: ['Name', 'Email'],
    sampleRows: [{ rowNumber: 1, cells: ['Alex Example', 'alex@example.test'] }], suggestedMapping: { Name: 'person_name', Email: 'email' },
    rowCount: 1, validCount: 1, errors: [], duplicateCandidates: [], expiresAt: '2026-09-11T12:00:00.000Z',
  });
  let previewAccepted = false;
  let imported = false;
  let nativeDraft: RequestedFollowupDraft | undefined;
  let nativeDraftUpdated = false;
  const ownerReceipt = () => mutationReceiptSchema.parse({ revision: 2, affectedPersonIds: [P], affectedSalesCycleIds: [C] });
  const read = <I, O>(method: string, parseInput: (input: I) => unknown, value: (input: I) => O) => async (input: I): Promise<O> => {
    calls.push({ method, kind: 'read', args: [structuredClone(input)] });
    parseInput(input);
    return structuredClone(value(input));
  };
  api.leads.list = read('leads.list', input => leadsListRequestSchema.parse(input), () => leadsListResponseSchema.parse({ rows, total: rows.length, nextCursor: null, revision: leadsRevision }));
  api.leadDetail.get = read('leadDetail.get', input => leadDetailRequestSchema.parse(input), input => {
    const detail = details.get(input.personId);
    requireCase(detail !== undefined);
    return leadDetailSchema.parse(detail);
  });
  api.conversations.list = read('conversations.list', input => conversationsListRequestSchema.parse(input), () => conversationsListResponseSchema.parse({
    rows: [...conversations.values()].map(({ transcript, ...row }) => { void transcript; return conversationRowSchema.parse(row); }), total: conversations.size, nextCursor: null, revision: conversationsRevision,
  }));
  api.conversations.get = read('conversations.get', input => conversationDetailRequestSchema.parse(input), input => {
    const detail = conversations.get(input.activityId);
    requireCase(detail !== undefined);
    return conversationDetailSchema.parse(detail);
  });
  api.learnings.list = read('learnings.list', input => learningsListRequestSchema.parse(input), () => learningsListResponseSchema.parse(learnings));
  let rejectNextTodayRead = false;
  api.today.get = async () => {
    calls.push({ method: 'today.get', kind: 'read', args: [] });
    if (rejectNextTodayRead) {
      rejectNextTodayRead = false;
      throw Error('SYNTHETIC_READ_UNAVAILABLE');
    }
    return todaySnapshotSchema.parse(structuredClone(today));
  };
  api.discovery.getBrief = read('discovery.getBrief', input => discoveryBriefRequestSchema.parse(input), input => {
    requireCase(input.personId === P);
    return discoveryBriefSchema.parse(brief);
  });
  const originalDaily = api.daily.get;
  api.daily.get = async () => {
    // The original explicit read owns its exact log entry. Never call a command or factory.
    const snapshot = dailySnapshotSchema.parse(await originalDaily());
    const answer = snapshot.answers.find(answer => answer.kind === 'requested_followup' && answer.accountId === 'a');
    if (answer?.kind === 'requested_followup') {
      if (nativeDraftUpdated && nativeDraft) answer.draft = structuredClone(nativeDraft);
      else nativeDraft = structuredClone(answer.draft);
    }
    return dailySnapshotSchema.parse(snapshot);
  };

  const operations: ModalOperation[] = [];
  const pending = new Map<string, { resolve: () => void; reject: () => void }>();
  const command = <I, O>(method: ModalMethod, parse: (input: I) => I, prepare: (input: I) => { response: O; apply: () => void }) => async (input: I): Promise<O> => {
    const operation = operations.find(operation => operation.method === method && operation.state === 'armed');
    calls.push({ method, kind: operation ? 'command' : 'forbidden', args: [structuredClone(input)] });
    if (!operation) throw Error(`Application fixture forbids ${method}`);
    // Consume the budget even when validation fails. A malformed attempt cannot retain an allowance.
    operation.state = 'rejected';
    operation.input = structuredClone(input);
    const captured = structuredClone(parse(input));
    operation.input = structuredClone(captured);
    const prepared = prepare(captured);
    operation.state = 'pending';
    return new Promise<O>((resolve, reject) => {
      pending.set(operation.token, {
        resolve: () => { prepared.apply(); resolve(structuredClone(prepared.response)); },
        reject: () => reject(Error('SYNTHETIC_RESPONSE_UNAVAILABLE')),
      });
    });
  };
  api.imports.preview = command('imports.preview', input => importSourceSchema.parse(input), input => {
    requireCase(input.kind === 'spreadsheet_paste' && input.sourceName === 'Pasted rows' && input.content === sourceText);
    const response = importPreviewSchema.parse(preview);
    return { response, apply: () => { previewAccepted = true; } };
  });
  api.imports.remap = command('imports.remap', input => importRemapRequestSchema.parse(input), input => {
    requireCase(previewAccepted && input.previewId === preview.previewId && input.contentHash === preview.contentHash);
    requireCase(Object.keys(input.mapping).sort().join(',') === 'Email,Name' && input.mapping.Name === 'person_name');
    const response = importPreviewSchema.parse({ ...preview, suggestedMapping: input.mapping });
    return { response, apply: () => { preview = response; } };
  });
  api.imports.commit = command('imports.commit', input => importCommitRequestSchema.parse(input), input => {
    requireCase(previewAccepted && !imported && input.previewId === preview.previewId && input.contentHash === preview.contentHash);
    requireCase(Object.keys(input.mapping).length === 2 && input.mapping.Name === preview.suggestedMapping.Name && input.mapping.Email === preview.suggestedMapping.Email);
    requireCase(input.source.channel === 'custom' && input.source.referredByPersonId === null && input.duplicateDecisions.length === 0);
    const response = importCommitReceiptSchema.parse({ jobId: 'import-case-1', importedPersonIds: ['person-imported-case-1'], importedRowCount: 1, revision: 2 });
    const row = leadRowSchema.parse({ ...rows[0], personId: response.importedPersonIds[0], salesCycleId: 'cycle-imported-case-1', personName: 'Alex Example', initials: 'AE', organization: null, stage: 'ready' });
    return { response, apply: () => { rows.push(row); leadsRevision = 2; imported = true; } };
  });
  api.learnings.capture = command('learnings.capture', input => captureLearningRequestSchema.parse(input), input => {
    requireCase(input.contradictionOf === null && input.evidence.every(evidence => evidence.personId === null && evidence.activityId === null));
    const row = learningRowSchema.parse({
      learningId: `learning-case-${learnings.rows.length + 1}`, category: input.category, statement: input.statement, confidence: input.confidence,
      status: 'active', statusReason: null, sampleSize: 1, firstObservedAt: T, latestObservedAt: T, createdAt: T, version: 1, contradictionOf: null,
      evidence: input.evidence.map((evidence, index) => ({ ...evidence, id: `learning-evidence-case-${index + 1}`, personName: null as null })),
    });
    const response = mutationReceiptSchema.parse({ revision: 2, affectedPersonIds: [], affectedSalesCycleIds: [] });
    const next = learningsListResponseSchema.parse({ rows: [...learnings.rows, row], totalActiveCount: learnings.totalActiveCount + 1, revision: 2 });
    return { response, apply: () => { learnings = next; } };
  });
  api.conversations.attachTranscript = command('conversations.attachTranscript', input => attachTranscriptRequestSchema.parse(input), input => {
    requireCase(input.personId === P && input.activityId === 'activity-call-kevin');
    const current = conversations.get(input.activityId)!;
    requireCase(current.transcript === null);
    const next = conversationDetailSchema.parse({ ...current, transcriptAvailable: true, transcript: {
      transcriptId: 'transcript-case-1', source: 'manual_paste', createdAt: T,
      utterances: [{ id: 'utterance-case-1', sequence: 0, speaker: 'founder', text: 'Thanks for the call.' }, { id: 'utterance-case-2', sequence: 1, speaker: 'lead', text: 'Happy to discuss maintenance.' }],
    } });
    return { response: ownerReceipt(), apply: () => { conversations.set(input.activityId, next); conversationsRevision = 2; } };
  });
  api.today.logPastActivity = command('today.logPastActivity', input => logPastActivityRequestSchema.parse(input), input => {
    requireCase(input.personId === P && input.salesCycleId === C && input.outboundCommandId === undefined);
    requireCase(input.outcome === null || (input.kind === 'call' && input.outcome === 'price_said'));
    const current = details.get(input.personId)!;
    const next = leadDetailSchema.parse({ ...current, revision: current.revision + 1, activities: [...current.activities, {
      id: `activity-manual-case-${current.activities.length + 1}`, kind: input.kind, occurredAt: input.occurredAt, summary: input.summary, outcome: input.outcome, markedInError: false,
    }] });
    const nextToday = todaySnapshotSchema.parse({ ...today, revision: today.revision + 1 });
    return { response: ownerReceipt(), apply: () => { details.set(input.personId, next); today = nextToday; } };
  });
  api.discovery.override = command('discovery.override', input => overrideDiscoveryRequestSchema.parse(input), input => {
    requireCase(input.personId === P && input.assessmentId === brief.assessment?.id && input.expectedFingerprint === brief.assessment?.fingerprint);
    const next = discoveryBriefSchema.parse({ ...brief, latestOverride: { id: '20000000-0000-4000-8000-000000000002', assessmentId: input.assessmentId, decision: input.decision, reason: input.reason, createdAt: T, evidenceChanged: false } });
    return { response: ownerReceipt(), apply: () => { brief = next; } };
  });
  const delegation: CalliePreloadApi['delegation'] = { ...api.delegation, editRequestedFollowup: command('delegation.editRequestedFollowup', input => editRequestedFollowupSchema.parse(input), input => {
    requireCase(nativeDraft !== undefined && input.accountId === 'a' && input.draftId === nativeDraft.id && input.expectedRevision === nativeDraft.revision);
    const response = savedRequestedFollowupSchema.parse({ draft: { ...nativeDraft, revision: nativeDraft.revision + 1, subject: input.subject, body: input.body, generation: 'edited', updatedAt: T }, stale: false, approval: null });
    return { response, apply: () => { nativeDraft = response.draft; nativeDraftUpdated = true; } };
  }) };
  // Opt-in Friday data is independent of renderer internals and of the old eight permissions.
  let fridayReport = fridayScenario ? fridayReportSchema.parse({
    periodStartsAt: '2026-09-07T04:00:00.000Z', periodEndsAt: '2026-09-14T04:00:00.000Z', asOf: T,
    metrics: [], sourceRows: [], revision: 1,
    jobs: [
      { id: 'job-friday-kevin', salesCycleId: 'friday-cycle-kevin', requestedAt: '2026-09-08T13:00:00.000Z', status: 'requested', contractorAcceptedAt: null },
      { id: 'job-friday-maya', salesCycleId: 'friday-cycle-maya', requestedAt: '2026-09-09T13:00:00.000Z', status: 'requested', contractorAcceptedAt: null },
    ],
  }) : undefined;
  let rejectNextFridayRead = false;
  const friday: CalliePreloadApi['friday'] | undefined = fridayScenario ? {
    ...api.friday,
    getCurrent: async (...args) => {
      calls.push({ method: 'friday.getCurrent', kind: 'read', args: structuredClone(args) });
      requireCase(args.length <= 1);
      const input = fridayReportRequestSchema.optional().parse(args[0]);
      requireCase(input === undefined || input.weekOffset === 0);
      if (rejectNextFridayRead) {
        rejectNextFridayRead = false;
        throw Error('SYNTHETIC_FRIDAY_READ_UNAVAILABLE');
      }
      return fridayReportSchema.parse(structuredClone(fridayReport));
    },
    createJob: command('friday.createJob', input => createJobRequestSchema.parse(input), input => {
      requireCase(fridayReport !== undefined && input.jobId.startsWith('job-'));
      requireCase(input.salesCycleId === 'friday-cycle-new' && input.requestedAt === '2026-09-08T14:15:00.000Z');
      requireCase(!fridayReport.jobs.some(job => job.id === input.jobId));
      const next = fridayReportSchema.parse({ ...fridayReport, revision: fridayReport.revision + 1,
        jobs: [...fridayReport.jobs, jobRequestSchema.parse({ id: input.jobId, salesCycleId: input.salesCycleId, requestedAt: input.requestedAt, status: 'requested', contractorAcceptedAt: null })] });
      const response = mutationReceiptSchema.parse({ revision: next.revision, affectedPersonIds: [], affectedSalesCycleIds: [input.salesCycleId] });
      return { response, apply: () => { fridayReport = next; } };
    }),
    fillJob: command('friday.fillJob', input => fillJobRequestSchema.parse(input), input => {
      requireCase(fridayReport !== undefined && input.jobId === 'job-friday-kevin' && input.contractorAcceptedAt === '2026-09-09T15:30:00.000Z');
      requireCase(fridayReport.jobs.find(job => job.id === input.jobId)?.status === 'requested');
      const next = fridayReportSchema.parse({ ...fridayReport, revision: fridayReport.revision + 1,
        jobs: fridayReport.jobs.map(job => job.id === input.jobId ? jobRequestSchema.parse({ ...job, status: 'filled', contractorAcceptedAt: input.contractorAcceptedAt }) : job) });
      const response = mutationReceiptSchema.parse({ revision: next.revision, affectedPersonIds: [], affectedSalesCycleIds: ['friday-cycle-kevin'] });
      return { response, apply: () => { fridayReport = next; } };
    }),
    cancelJob: command('friday.cancelJob', input => cancelJobRequestSchema.parse(input), input => {
      requireCase(fridayReport !== undefined && input.jobId === 'job-friday-maya');
      requireCase(fridayReport.jobs.find(job => job.id === input.jobId)?.status === 'requested');
      const next = fridayReportSchema.parse({ ...fridayReport, revision: fridayReport.revision + 1,
        jobs: fridayReport.jobs.map(job => job.id === input.jobId ? jobRequestSchema.parse({ ...job, status: 'cancelled' }) : job) });
      const response = mutationReceiptSchema.parse({ revision: next.revision, affectedPersonIds: [], affectedSalesCycleIds: ['friday-cycle-maya'] });
      return { response, apply: () => { fridayReport = next; } };
    }),
  } : undefined;
  const controller: ModalController = Object.freeze({
    rejectNextRead(method: 'today.get' | 'friday.getCurrent') {
      if (method === 'friday.getCurrent') {
        requireCase(fridayScenario);
        if (rejectNextFridayRead) throw Error('SYNTHETIC_READ_FAILURE_OUTSTANDING');
        rejectNextFridayRead = true;
        return;
      }
      requireCase(method === 'today.get');
      if (rejectNextTodayRead) throw Error('SYNTHETIC_READ_FAILURE_OUTSTANDING');
      rejectNextTodayRead = true;
    },
    arm(method: ModalMethod) {
      const isFriday = fridayModalMethods.some(candidate => candidate === method);
      requireCase(modalMethods.some(candidate => candidate === method) || (fridayScenario && isFriday));
      if (isFriday && operations.some(operation => fridayModalMethods.some(candidate => candidate === operation.method) && (operation.state === 'armed' || operation.state === 'pending'))) throw Error('SYNTHETIC_OPERATION_OUTSTANDING');
      if (operations.some(operation => operation.method === method && (operation.state === 'armed' || operation.state === 'pending'))) throw Error('SYNTHETIC_OPERATION_OUTSTANDING');
      const token = `modal-operation-${operations.length + 1}`;
      operations.push({ token, method, input: null, state: 'armed' });
      return token;
    },
    settle(token: string, outcome: 'resolve' | 'reject') {
      requireCase(outcome === 'resolve' || outcome === 'reject');
      const operation = operations.find(operation => operation.token === token);
      const deferred = pending.get(token);
      if (!operation || operation.state !== 'pending' || !deferred) throw Error('SYNTHETIC_OPERATION_NOT_PENDING');
      pending.delete(token);
      operation.state = outcome === 'resolve' ? 'resolved' : 'rejected';
      deferred[outcome]();
    },
    get operations() { return structuredClone(operations); },
  });
  return { api: { ...api, delegation, ...(friday ? { friday } : {}) }, controller };
}
