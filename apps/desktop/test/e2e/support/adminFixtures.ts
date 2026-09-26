import type { AdminState } from '../../../src/renderer/settingsContract.ts';
import { settingHistoryAnswer } from '../../support/settingHistory.ts';
import type { Call } from './appServer.ts';

/**
 * The Administration and Dashboard views' fixtures and the `callieAdmin` fake's scripted
 * answers, for the one harness (`appServer.ts`). Home's sidebar and "Last 7 days" read
 * the same bridge.
 *
 * **Two roles, always.** Every fixture exists for an admin and for a salesperson. A
 * suite that only ever ran as an admin would pass with the inert-control logic
 * deleted, which is the thing most worth proving on this page.
 *
 * No real name, address or number appears here. `example.test` is reserved by
 * RFC 6761.
 */

export const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
export const ALERT_ID = '33333333-3333-4333-8333-333333333333';

export function settingsSnapshot(overrides: Record<string, unknown> = {}): NonNullable<AdminState['settings']> {
  return {
    settings: [
      {
        settingKey: 'sending_enabled',
        value: { enabled: false, releaseGateReference: null },
        version: 0,
        changedAt: null,
        changedByUserId: null,
        changeNote: null,
      },
      // A configured slice, so the page has provenance to render beside a default.
      // This was `postal_footer` until migration 0015 removed that slice; there is no
      // postal footer to administer any more.
      {
        settingKey: 'business_time_zone',
        value: { timeZone: 'America/Chicago' },
        version: 2,
        changedAt: '2026-09-19T10:00:00.000Z',
        changedByUserId: ADMIN_ID,
        changeNote: 'the office moved',
      },
    ],
    elsewhere: [
      { topic: 'Research limits', path: '/research/config', ownedBy: 'G10 research' },
      { topic: 'Sending caps and the ramp', path: '/outbound/cap', ownedBy: 'G7-2 sending' },
      { topic: 'State postures', path: '/postures', ownedBy: 'G4 policy' },
    ],
    holidayCalendar: { version: '2026-federal', dates: ['2026-12-25'] },
    deploymentSendingEnabled: false,
    effectiveSendingEnabled: false,
    ...overrides,
  } as NonNullable<AdminState['settings']>;
}

export function dashboard(): NonNullable<AdminState['dashboard']> {
  return {
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    audience: 'assigned',
    firmsInScope: 3,
    messages: { incomingMatched: 4, human: 2, uncertain: 1, automated: 1, bounces: 0, optOuts: 0 },
    replyHandling: { replies: 2, handled: 1, medianSecondsToHandle: 900, slowestSecondsToHandle: 1800 },
    calls: [{ key: 'voicemail_left', count: 3 }],
    stageMovement: [{ key: 'contacting', count: 1 }],
    holds: { open: 1, byReason: [{ reasonCode: 'scoped_pause', count: 1, oldestAgeSeconds: 60 }] },
    suppressions: [],
    sending: { available: false, owner: 'G7-2', reason: 'the outbound fence is not in this build' },
    enrollments: { available: false, owner: 'G8', reason: 'sequences are not in this build' },
    classifier: { available: false, owner: 'G7b', reason: 'model records are not in this build' },
  } as NonNullable<AdminState['dashboard']>;
}

export function diagnostics(): NonNullable<AdminState['diagnostics']> {
  return {
    restore: { systemGeneration: 1, expectedSystemGeneration: 2, mismatch: true },
    schema: { appliedVersion: 13, declaredRange: { minimum: 13, maximum: 13 }, accepted: true },
    clientVersions: { minimum: '1.0.0', maximum: '1.4.0' },
    sending: { deploymentEnabled: false, adminEnabled: false, effective: false },
    jobs: { runnable: 0, running: 0, retryable: 0, dead: 1, oldestRunnableAgeSeconds: null, oldestDeadAgeSeconds: 4000 },
    heartbeats: [
      { component: 'worker', instanceKey: 'worker-1', ageSeconds: 5, expectedIntervalSeconds: 60, fresh: true },
    ],
    canaryCompletionAgeSeconds: 120,
    alerts: [
      {
        id: ALERT_ID,
        alertKey: 'canary_stale',
        severity: 'critical',
        raisedAt: '2026-09-20T10:00:00.000Z',
        acknowledgedAt: null,
        runbookPath: 'docs/greenfield/runbooks/canary_stale.md',
      },
    ],
    mailboxes: [
      {
        mailboxId: '44444444-4444-4444-8444-444444444444',
        ownerUserId: ADMIN_ID,
        status: 'connected',
        syncState: 'ready',
        coverageWatermarkAt: '2026-09-20T09:00:00.000Z',
        lastSyncedAt: '2026-09-20T09:00:00.000Z',
        lastSyncError: null,
        watchExpiresAt: '2026-09-27T09:00:00.000Z',
        hoursToWatchExpiry: 168,
        automationHeld: false,
      },
    ],
    mailboxVisibility: 'all',
  } as NonNullable<AdminState['diagnostics']>;
}

/** G7-2's posture, as `/outbound/status` would answer it: checklist incomplete. */
export function sendingPosture(): NonNullable<AdminState['sendingAdmin']> {
  return {
    domain: {
      domain: 'sending.example.test',
      spfPass: true,
      dkimPass: true,
      dmarcPass: false,
      postmasterReviewedAt: null,
      authenticationPasses: false,
      automatedSendingEnabled: false,
      personalGmailGuardPer24h: 4000,
    },
    personalGmailRecipients: 17,
    ramps: [
      {
        mailboxId: '44444444-4444-4444-8444-444444444444',
        healthySendingDays: 3,
        effectiveCap: 5,
        adminDailyCap: null,
        raisedDailyCap: null,
        lastHealthFailure: null,
      },
    ],
  };
}

export const POSTURE_ID = '44444444-4444-4444-8444-444444444444';

/** The postures reference the API serves (lane g84), cut to two statements and two states. */
export function postureReference(): NonNullable<NonNullable<AdminState['postures']>['reference']> {
  return {
    rulesRevision: 2,
    statements: [
      { key: 'federal_rules_apply', text: 'I understand the federal calling rules apply.' },
      { key: 'state_rules_checked', text: 'I checked this state’s rules myself.' },
    ],
    federalCitations: [{ title: 'Federal rule', url: 'https://example.test/federal', quote: 'A quoted federal line.' }],
    states: [
      { state: 'AL', name: 'Alabama', rule: null },
      {
        state: 'RI',
        name: 'Rhode Island',
        rule: {
          summary: 'Rhode Island quoted summary.',
          citations: [{ title: 'R.I. rule', url: 'https://example.test/ri', quote: 'A quoted Rhode Island line.' }],
        },
      },
      { state: 'TX', name: 'Texas', rule: null },
    ],
  };
}

/** One posture in force for Rhode Island, as `GET /postures` lists it. */
export function recordedPosture(overrides: Record<string, unknown> = {}): NonNullable<NonNullable<AdminState['postures']>['records']>[number] {
  return {
    id: POSTURE_ID,
    state: 'RI',
    revision: 1,
    effectiveFrom: '2026-09-01T05:00:00.000Z',
    effectiveTo: null,
    reviewAt: '2099-09-01T05:00:00.000Z',
    rulesRevision: 2,
    confirmedStatements: ['federal_rules_apply', 'state_rules_checked'],
    sources: [{ title: 'R.I. rule', url: 'https://example.test/ri' }],
    confirmedByUserId: ADMIN_ID,
    revokedAt: null,
    ...overrides,
  };
}

export function adminState(overrides: Partial<AdminState> = {}): AdminState {
  return {
    screen: 'settings',
    role: 'admin',
    online: true,
    mayMutate: true,
    notice: null,
    settings: settingsSnapshot(),
    dashboard: null,
    diagnostics: null,
    stages: [
      { key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false },
      { key: 'won', displayName: 'Won', position: 2, terminalKind: 'won', retired: false },
    ],
    history: null,
    sendingAdmin: null,
    sendingReadError: null,
    callingNumbers: [],
    postures: { reference: postureReference(), records: [recordedPosture()], readError: null },
    ...overrides,
  };
}

/**
 * `callieAdmin`, scripted. What each outcome proves is in the spec that uses it.
 * `figuresFail` is Home's "Last 7 days" read refused.
 */
export function adminAnswer(
  initial: AdminState,
  method: string,
  argument: unknown,
  calls: readonly Call[],
  figuresFail: boolean,
): AdminState {
  let state = initial;
  if (method === 'loadDashboard') {
    // The real bridge echoes the window it was asked for in the answer's own `window`.
    // A failed read keeps whatever figures it held before, which is why Home checks the
    // window rather than the presence of figures.
    const window = argument as { from: string; to: string };
    return figuresFail
      ? { ...state, notice: 'offline', dashboard: { ...dashboard() } }
      : { ...state, notice: null, dashboard: { ...dashboard(), window } };
  }
  // The scripted outcomes. What each one proves is in the spec that uses it.
  if (method === 'show') {
    const screen = (argument as { screen?: AdminState['screen'] } | null)?.screen ?? 'settings';
    state = {
      ...state,
      screen,
      notice: null,
      dashboard: screen === 'dashboard' ? dashboard() : state.dashboard,
      diagnostics: screen === 'diagnostics' ? diagnostics() : state.diagnostics,
    };
    // Settings shown again re-reads the sending posture (lane g69): a read that
    // failed is answered this time, which is what Retry is for. The first show is the
    // view opening, which reads it and fails as the fixture says.
    if (screen === 'settings' && state.sendingReadError !== null && calls.filter(call => call.method === 'show').length > 1) {
      state = { ...state, sendingAdmin: sendingPosture(), sendingReadError: null };
    }
  }
  // An admin-only refusal arrives as its code, which the view turns into one
  // sentence. This is what a salesperson gets.
  if (method === 'saveSetting') {
    state = { ...state, notice: state.role === 'admin' ? null : 'admin_only' };
  }
  // The history the route answers (lane g78): values included, which is what
  // the window draws as "from" and "to".
  if (method === 'openHistory') {
    state = { ...state, notice: null, history: settingHistoryAnswer() };
  }
  // Lane g84. Texas is refused as overlapping, the way the server refuses a state
  // that already has a posture in force; any other state is recorded and listed.
  if (method === 'recordPosture' && state.postures !== undefined && state.postures !== null) {
    const asked = argument as { state: string; effectiveFromDate: string };
    if (asked.state === 'TX') {
      state = { ...state, notice: 'posture_overlapping' };
    } else {
      const added = recordedPosture({
        id: '55555555-5555-4555-8555-555555555555',
        state: asked.state,
        effectiveFrom: `${asked.effectiveFromDate}T05:00:00.000Z`,
      });
      state = {
        ...state,
        notice: 'posture_recorded',
        postures: { ...state.postures, records: [...(state.postures.records ?? []), added] },
      };
    }
  }
  if (method === 'revokePosture' && state.postures !== undefined && state.postures !== null) {
    const { postureId } = argument as { postureId: string };
    state = {
      ...state,
      notice: 'posture_revoked',
      postures: {
        ...state.postures,
        records: (state.postures.records ?? []).map(row =>
          row.id === postureId ? { ...row, revokedAt: '2026-09-25T15:00:00.000Z' } : row,
        ),
      },
    };
  }
  if (method === 'acknowledgeAlert') {
    state = {
      ...state,
      diagnostics: {
        ...diagnostics(),
        alerts: diagnostics().alerts.map(alert => ({ ...alert, acknowledgedAt: '2026-09-20T11:00:00.000Z' })),
      },
    };
  }
  return state;
}
