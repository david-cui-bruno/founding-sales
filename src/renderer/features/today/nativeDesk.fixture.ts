import { localWorkspaceSnapshotSchema, localCommitmentsSnapshotSchema, localDraftContinuationSchema, localCompanyDetailSchema, type LocalWorkspaceSnapshot, type LocalCommitmentsSnapshot, type LocalDraftContinuation, type LocalWorkspaceApi, type LocalWorkflowReceipt, type LocalCompanyDetail } from '../../../shared/contracts/localWorkspaceContract';
import { createLocalCompanyContinuation } from './localCompanyContinuation';
/** Test-only browser-safe factory. Never imported by production components. */
import {
  dailySnapshotSchema,
  type DailySnapshot,
} from '../../../shared/contracts/dailyContract';
import type { RequestedFollowupDraft } from '../../../shared/contracts/requestedFollowupContract';
const hash = 'a'.repeat(64);
export const fixtureNow = '2026-09-09T12:00:00.000Z';
export function localSnapshot(overrides: Partial<LocalWorkspaceSnapshot> = {}): LocalWorkspaceSnapshot {
  return localWorkspaceSnapshotSchema.parse({ scope: 'local_database', generatedAt: fixtureNow, workflowMode: 'meeting_first', transitionReceipt: null, accounts: { state: 'available', snapshots: [] }, ...overrides });
}
export function commitments(overrides: Partial<LocalCommitmentsSnapshot> = {}): LocalCommitmentsSnapshot {
  return localCommitmentsSnapshotSchema.parse({ scope: 'local_database', generatedAt: fixtureNow, revision: 1, reviewErrorCount: 0, items: [], ...overrides });
}
/** One saved, unsent local company draft as the local provider would list it. Saved data only; nothing here sends. */
export function localDraftContinuation(overrides: Partial<LocalDraftContinuation> = {}): LocalDraftContinuation {
  return localDraftContinuationSchema.parse({ accountId: 'a', draftId: 'draft-a', companyLabel: 'Account A', subject: 'Maintenance request coordination',
    revision: 2, updatedAt: fixtureNow, email: 'info@a.fixture.invalid', ...overrides });
}
export function requestedDraft(accountId = 'a'): RequestedFollowupDraft {
  const originalCall = {
    commandId: 'call',
    handoffId: 'handoff',
    actionId: 'action',
    commandFingerprint: hash,
    outcomeEventId: 'event',
    outcomeEventHash: hash,
  };
  return {
    kind: 'requested_phone_followup',
    id: `draft-${accountId}`,
    accountId,
    revision: 1,
    mailboxSubject: 'mailbox',
    sender: 'founder@fixture.invalid',
    recipient: `${accountId}@fixture.invalid`,
    recipientBinding: {
      kind: 'owner_supplied',
      email: `${accountId}@fixture.invalid`,
      originalCall,
    },
    accountVersion: 1,
    researchRevision: 1,
    contextRevision: hash,
    originalCall,
    mailContext: {
      scopeRevision: null,
      scopeFingerprint: null,
      inboundContextRevision: null,
      inboundContextFingerprint: hash,
    },
    subject: `Information for ${accountId}`,
    body: `Saved note for ${accountId}`,
    evidenceIds: ['event'],
    generation: 'edited',
    updatedAt: fixtureNow,
  };
}
export function dailyFixture(
  overrides: Partial<DailySnapshot> = {},
): DailySnapshot {
  return dailySnapshotSchema.parse({
    workspaceId: 'ws',
    workflowMode: 'meeting_first',
    revision: hash,
    freshness: {
      kind: 'local_snapshot',
      generatedAt: fixtureNow,
      remote: 'unknown',
    },
    accounts: ['a', 'b'].map((id): DailySnapshot['accounts'][number] => ({
      account: {
        id,
        name: `Account ${id.toUpperCase()}`,
        domain: null,
        version: 1,
      },
      claims: [
        {
          kind: 'hypothesis',
          key: 'pain',
          value: 'Unconfirmed workflow',
          evidenceIds: [],
        },
      ],
      routes: [],
      portfolio: [
        {
          count: 12,
          measure: 'buildings',
          scope: 'managed',
          evidenceIds: ['source'],
        },
      ],
      unknowns: ['Decision maker'],
      conflicts: [],
      fingerprint: hash,
    })),
    calls: { accountIds: ['a'], workloadConflict: false },
    callSettings: { newCallSlots: 3, totalCallCapacity: 5 },
    answers: ['a', 'b'].map((accountId): DailySnapshot['answers'][number] => ({
      kind: 'requested_followup',
      accountId,
      draft: requestedDraft(accountId),
      approval: null,
      capability: 'held',
      reason: 'requires_owner_preflight',
    })),
    campaigns: [],
    ownerStatus: [],
    transport: [],
    issues: [],
    ...overrides,
  });
}
export function linkedInFixture(): Extract<
  DailySnapshot['answers'][number],
  { kind: 'manual_linkedin' }
> {
  return {
    kind: 'manual_linkedin',
    accountId: 'a',
    capability: 'manual_only',
    draft: {
      id: 'linkedin-a',
      workspaceId: 'ws',
      accountId: 'a',
      enrollmentId: 'enrollment',
      campaignVersionId: 'version',
      personId: null,
      stepId: 'li-step',
      routeId: 'li-route',
      routeVersion: 1,
      contextRevision: 1,
      executionContextId: 'context',
      revision: 1,
      body: 'Manual note',
      contentHash: hash,
      targetHash: hash,
      state: 'draft',
      updatedAt: fixtureNow,
    },
    recovery: {
      draftId: 'linkedin-a',
      revision: 1,
      approvalCommandId: null,
      attempts: [],
      handoffId: null,
      started: false,
    },
  };
}

import type { NativeDeskApi } from './NativeDeskRoute';
import type { CommandReceipt } from '../../../shared/contracts/commandReceiptContract';
import { requestedFollowupDraftSchema } from '../../../shared/contracts/requestedFollowupContract';
import { accountPreparationSchema, type AccountPreparation } from '../../../shared/contracts/accountPreparationContract';
export function configuredFixtureStatus(): Awaited<
  ReturnType<NativeDeskApi['delegation']['status']>
> {
  return {
    state: 'active',
    workspaceId: 'ws',
    endpoint: 'https://owner.fixture.invalid',
    configuration: {
      revision: 1,
      configuration: { version: 1, state: 'active', research: null },
      updatedAt: fixtureNow,
    },
  };
}
/** Isolated, framework-neutral fixture API. Every command is recorded, no IO. */
export function nativeDeskFixture(initial = dailyFixture()) {
  let snapshot = structuredClone(initial);
  let local = localSnapshot({ workflowMode: initial.workflowMode === 'legacy' ? 'legacy' : 'meeting_first' });
  let retained = commitments();
  let config = configuredFixtureStatus();
  // Absent by default: the preparation read stays a forbidden capability unless a test supplies one.
  let preparation: AccountPreparation | null = null;
  // Absent by default: the selected company detail (sources with excerpts) is unavailable unless a test supplies one.
  let companyDetails = new Map<string, LocalCompanyDetail>();
  const calls: { method: string; input?: unknown }[] = [];
  const record = (method: string, input?: unknown) => {
    calls.push({ method, input: structuredClone(input) });
  };
  const forbidden = async (): Promise<never> => {
    record('forbidden');
    throw Error('Unavailable fixture capability');
  };
  const receipt = (
    commandId: string,
    status: CommandReceipt['status'] = 'applied',
  ): CommandReceipt => ({
    commandId,
    status,
    authorityGeneration: 1,
    aggregateVersion: 2,
    reason: null,
  });
  const retainPending = (accountId: string, commandId: string) => {
    const owner = snapshot.ownerStatus.find(o => o.accountId === accountId);
    if (owner && !owner.pendingCommands.some(c => c.commandId === commandId)) {
      owner.pendingCommands.push(receipt(commandId, 'pending'));
      owner.status = 'pending';
    }
  };
  const requested = (accountId: string, draftId: string) => {
    const item = snapshot.answers.find(
      (a) =>
        a.kind === 'requested_followup' &&
        a.accountId === accountId &&
        a.draft.id === draftId,
    );
    if (!item || item.kind !== 'requested_followup')
      throw Error('Fixture draft not found');
    return item;
  };
  const linked = (draftId: string, revision: number) => {
    const item = snapshot.answers.find(
      (a) => a.kind === 'manual_linkedin' && a.draft.id === draftId,
    );
    if (
      !item ||
      item.kind !== 'manual_linkedin' ||
      item.draft.revision !== revision
    )
      throw Error('Fixture revision conflict');
    return item;
  };
  const api: NativeDeskApi & { localWorkspace: LocalWorkspaceApi } = {
    leads: { list: async input => { record('leads.list', input); throw Error('Saved people unavailable in this fixture'); } },
    leadDetail: { get: async input => { record('leadDetail.get', input); throw Error('Saved person detail unavailable in this fixture'); } },
    localWorkspace: {
      get: async () => { record('localWorkspace.get'); return structuredClone(local); },
      getCompany: async input => {
        record('localWorkspace.getCompany', input);
        const detail = companyDetails.get(input.accountId);
        if (!detail) throw Error('Selected company detail unavailable in this fixture');
        return structuredClone(detail);
      },
      researchCompany: async () => { record('localWorkspace.researchCompany'); throw Error('Selected company research unavailable in this fixture'); },
      getCompanyResearchStatus: async () => { record('localWorkspace.getCompanyResearchStatus'); throw Error('Selected company research unavailable in this fixture'); },
      prepareCompanyDraft: async () => { throw Error('Company preparation unavailable in this fixture'); }, admitCompanyDraftEmail: async () => { throw Error('Company drafts unavailable in this fixture'); }, openCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, saveCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyResearchSettings: async () => { throw Error('Local research setup unavailable in this fixture'); }, updateCompanyResearchSettings: async () => { throw Error('Local research setup unavailable in this fixture'); }, getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: async input => { record('localWorkspace.linkCompanyPerson', input); throw Error('Reviewed company link unavailable in this fixture'); },
      getCommitments: async () => { record('localWorkspace.getCommitments'); return structuredClone(retained); },
      reviewCompany: async () => { record('localWorkspace.reviewCompany'); throw Error('Company intake unavailable in this fixture'); },
      createCompany: async () => { record('localWorkspace.createCompany'); throw Error('Company intake unavailable in this fixture'); },
      getCompanyCreateStatus: async () => { record('localWorkspace.getCompanyCreateStatus'); throw Error('Company intake unavailable in this fixture'); },
      transition: async (command) => {
        record('localWorkspace.transition', command);
        if (local.transitionReceipt?.commandId === command.commandId && local.transitionReceipt.manifestId === command.manifestId) return structuredClone(local.transitionReceipt);
        if (local.workflowMode !== 'legacy') throw Error('Fixture mode conflict');
        const receipt: LocalWorkflowReceipt = { commandId: command.commandId, manifestId: command.manifestId, mode: 'meeting_first' as const, revision: 1, occurredAt: fixtureNow, cancelledActionIds: [], stoppedEnrollmentIds: [], preservedActionIds: [], parkedPersonIds: [], callbackEvidenceIds: [], unknownDraftIds: [], parkedReviewActions: [], parkedActions: [] };
        local = localSnapshot({ ...local, workflowMode: 'meeting_first', transitionReceipt: receipt });
        snapshot = { ...snapshot, workflowMode: 'meeting_first' };
        return structuredClone(receipt);
      },
    },
    daily: {
      get: async () => {
        record('daily.get');
        return structuredClone(snapshot);
      },
    },
    delegation: {
      getAccountPreparation: async (input) => {
        if (!preparation || preparation.accountId !== input.accountId) return forbidden();
        record('getAccountPreparation', input);
        return structuredClone(preparation);
      },
      configureIntake: forbidden,
      refreshSelectedAccount: forbidden,
      // Local read only. The fixture holds no applied copy, so the honest answer is unknown.
      getSelectedAccountFreshness: async (input) => {
        record('getSelectedAccountFreshness', input);
        return { accountId: input.accountId, state: 'unknown', localFingerprint: hash, sentFingerprint: null, sentAt: null };
      },
      status: async () => {
        record('delegation.status');
        return structuredClone(config);
      },
      policyImport: {
        selectAndPreview: forbidden,
        confirm: forbidden,
        resume: forbidden,
        status: forbidden,
      },
      prepareRequestedFollowup: forbidden,
      reconcileReplyDraft: forbidden, editReplyDraft: forbidden, getPhoneHandoffState: forbidden, beginPhone: forbidden,
      bootstrap: forbidden,
      configurePolicy: forbidden,
      configureResearch: forbidden,
      pair: forbidden,
      pairing: forbidden,
      rotatePairing: forbidden,
      configure: forbidden,
      submit: forbidden,
      sync: async () => {
        record('delegation.sync');
        // No fabricated settlement. Tests must supply an authoritative snapshot.
        return { applied: 0, gaps: 0, cursor: null, ownerFresh: false };
      },
      getRequestedFollowup: async (input) => {
        record('getRequestedFollowup', input);
        const item = requested(input.accountId, input.draftId);
        return structuredClone({
          draft: item.draft,
          stale: false,
          approval: item.approval,
        });
      },
      editRequestedFollowup: async (input) => {
        record('editRequestedFollowup', input);
        const item = requested(input.accountId, input.draftId);
        if (item.draft.revision !== input.expectedRevision)
          throw Error('Fixture revision conflict');
        item.draft = requestedFollowupDraftSchema.parse({
          ...item.draft,
          revision: item.draft.revision + 1,
          subject: input.subject,
          body: input.body,
        });
        return structuredClone({
          draft: item.draft,
          stale: false,
          approval: item.approval,
        });
      },
      approveRequestedFollowup: async (input) => {
        record('approveRequestedFollowup', input);
        const item = requested(input.draft.accountId, input.draft.id);
        if (
          JSON.stringify(item.draft) !== JSON.stringify(input.draft) ||
          input.expectedRemoteDraftRevision !== item.draft.revision
        )
          throw Error('Fixture canonical mismatch');
        item.approval = {
          state: 'pending_preflight',
          receipt: receipt(input.intentCommandId, 'pending'),
          intentCommandId: null,
          reason: 'Fixture pending owner preflight',
        };
        retainPending(item.accountId, item.approval.receipt.commandId);
        return structuredClone(item.approval);
      },
    },
    linkedin: {
      prepare: forbidden,
      get: async (input) => {
        record('linkedin.get', input);
        return structuredClone(
          linked(input.draftId, input.expectedRevision).draft,
        );
      },
      recover: async (input) => {
        record('linkedin.recover', input);
        return structuredClone(
          linked(input.draftId, input.expectedRevision).recovery,
        );
      },
      save: async (input) => {
        record('linkedin.save', input);
        const item = linked(input.draftId, input.expectedRevision);
        item.draft = {
          ...item.draft,
          revision: item.draft.revision + 1,
          body: input.body,
        };
        item.recovery = { ...item.recovery, revision: item.draft.revision };
        return structuredClone(item.draft);
      },
      begin: async (input) => {
        record('linkedin.begin', input);
        const item = linked(input.draftId, input.expectedRevision);
        item.recovery = {
          ...item.recovery,
          started: true,
          handoffId: 'fixture-handoff',
          approvalCommandId: input.commandId,
        };
        return {
          draftId: input.draftId,
          revision: input.expectedRevision,
          status: 'started',
          handoffId: 'fixture-handoff',
          receipt: receipt(input.commandId),
        };
      },
      open: async (input) => {
        record('linkedin.open', input);
        linked(input.draftId, input.expectedRevision);
        return {
          draftId: input.draftId,
          revision: input.expectedRevision,
          status: 'opened',
        };
      },
      copy: async (input) => {
        record('linkedin.copy', input);
        linked(input.draftId, input.expectedRevision);
        return {
          draftId: input.draftId,
          revision: input.expectedRevision,
          status: 'copied',
        };
      },
      reportOutcome: async (input) => {
        record('linkedin.reportOutcome', input);
        const item = linked(input.draftId, input.expectedRevision);
        retainPending(item.accountId, input.commandId);
        return {
          draftId: input.draftId,
          revision: input.expectedRevision,
          receipt: receipt(input.commandId, 'pending'),
        };
      },
    },
  };
  return {
    api,
    firstUse: firstUseFixture(),
    calls,
    setLocalSnapshot(next: LocalWorkspaceSnapshot) { local = localWorkspaceSnapshotSchema.parse(structuredClone(next)); },
    setCommitments(next: LocalCommitmentsSnapshot) { retained = localCommitmentsSnapshotSchema.parse(structuredClone(next)); },
    setSnapshot(next: DailySnapshot) {
      snapshot = structuredClone(next);
    },
    setConfiguration(next: typeof config) {
      config = structuredClone(next);
    },
    setPreparation(next: AccountPreparation | null) {
      preparation = next ? accountPreparationSchema.parse(structuredClone(next)) : null;
    },
    /** Saved local company detail for the call card and phone review. Replaces the whole set; validated on the way in. */
    setCompanyDetails(next: readonly LocalCompanyDetail[]) {
      companyDetails = new Map(next.map(detail => [detail.snapshot.account.id, localCompanyDetailSchema.parse(structuredClone(detail))]));
    },
    snapshot: () => structuredClone(snapshot),
  };
}

/** All-lane synthetic review state for actual-component browser acceptance only. */
export function nativeDeskReviewFixture(): DailySnapshot {
  const snapshot = dailyFixture();
  snapshot.ownerStatus = snapshot.accounts.map(
    (a): DailySnapshot['ownerStatus'][number] => ({
      accountId: a.account.id,
      authority: {
        accountId: a.account.id,
        owner: 'worker',
        generation: 1,
        state: 'active',
      },
      executionVersion: 1,
      pendingCommands: [],
      status: 'owner_applied',
    }),
  );
  snapshot.answers.push(linkedInFixture());
  snapshot.campaigns = [
    {
      version: {
        id: 'version',
        campaignId: 'Fixture campaign',
        version: 1,
        audienceHash: hash,
        offer:
          'Review the recorded maintenance workflow and whether a short conversation would help.',
        objective: 'meeting',
        cohortAccountIds: ['a', 'b'],
        approvedAt: null,
        steps: [
          {
            id: 'call-step',
            channel: 'call',
            condition: 'initial',
            delayHours: 0,
          },
          {
            id: 'li-step',
            channel: 'linkedin',
            condition: 'no_reply',
            delayHours: 48,
          },
        ],
        capScope: 'campaign_version_lifetime',
        channelCaps: { call: 2, email: 1, linkedin: 1 },
        contentPolicyHash: hash,
      },
      snapshotHash: hash,
      caps: [],
      enrollments: [],
    },
  ];
  return dailySnapshotSchema.parse(snapshot);
}

/** Test-only detached continuation for legacy presentation fixtures. No IPC, timers or global cache. */
export function firstUseFixture() {
  const bundle = createLocalCompanyContinuation();
  bundle.activate();
  return bundle.continuation;
}
