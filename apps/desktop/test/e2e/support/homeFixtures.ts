import type { DesktopState, MailboxState } from '../../../src/shared/contract.ts';
import type { AdminState, CallingNumberView } from '../../../src/renderer/settingsContract.ts';
import type { TodayFirm, TodayState } from '../../../src/renderer/todayContract.ts';
import { adminState, dashboard, diagnostics, sendingPosture } from './adminFixtures.ts';
import type { Call } from './appServer.ts';

/**
 * Home's fixtures — the session, the lanes, the mailbox and a ready Administration —
 * and the `callieToday` fake's scripted answers, for the one harness (`appServer.ts`).
 *
 * The scripted answers are the ones G6's Today window specs used, so the lanes are
 * driven through exactly the scenarios that window was: scenario 33's five people at one
 * firm, the snooze that comes back a hold, the one usable route, the outcome form.
 *
 * No real business name, address or number appears here. `example.test` is reserved by
 * RFC 6761 and the numbers are in the NANP 555-01XX fictional block.
 */

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const FIRM_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_FIRM_ID = '22222222-2222-4222-8222-222222222222';
export const REPLY_FIRM_ID = '77777777-7777-4777-8777-000000000001';
export const DUE_FIRM_ID = '77777777-7777-4777-8777-000000000002';
export const MANUAL_ITEM_ID = '33333333-3333-4333-8333-333333333333';
export const AUTOMATED_ITEM_ID = '66666666-6666-4666-8666-666666666666';
export const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
export const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';
export const MAILBOX_ADDRESS = 'sales@example.test';

/** Signed in, online, a supported version, and the cached list the session holds. */
export function desktopState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    screen: 'today',
    clientVersion: '1.0.3',
    supportedClientVersions: { minimum: '1.0.0', maximum: '1.0.3' },
    device: {
      deviceId: '33333333-3333-4333-8333-333333333333',
      deviceLabel: "David's MacBook",
      workspaceId: WORKSPACE_ID,
      role: 'admin',
      registeredAt: '2026-09-21T09:00:00.000Z',
    },
    online: true,
    stale: false,
    asOf: '2026-09-21T13:00:00.000Z',
    mayMutate: true,
    notice: null,
    today: {
      workspaceId: WORKSPACE_ID,
      snapshotDate: '2026-09-21',
      businessTimeZone: 'America/New_York',
      cards: todayState().cards.map(card => ({ ...card })),
    },
    ...overrides,
  };
}

/** Scenario 33's Today half: five people at one firm, and one card for them. */
export function expandedFirm(overrides: Partial<TodayFirm> = {}): TodayFirm {
  return {
    firmId: FIRM_ID,
    firmName: 'Northwind Test Holdings',
    snapshotDate: '2026-09-21',
    lane: 'callback',
    counts: { replies: 0, emailsDue: 3, callsDue: 1 },
    tasks: [
      {
        itemId: '77777777-7777-4777-8777-777777777777',
        contactId: '88888888-8888-4888-8888-888888888888',
        contactName: 'Dana Example',
        kind: 'callback',
        lane: 'callback',
        dueAt: '2026-09-21T18:00:00.000Z',
        status: 'open',
        automated: false,
        snoozeUntil: null,
      },
      {
        itemId: MANUAL_ITEM_ID,
        contactId: '99999999-9999-4999-8999-999999999999',
        contactName: 'Robin Placeholder',
        kind: 'call_due',
        lane: 'due_work',
        dueAt: '2026-09-21T13:00:00.000Z',
        status: 'open',
        automated: false,
        snoozeUntil: null,
      },
      {
        itemId: AUTOMATED_ITEM_ID,
        contactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        contactName: 'Alex Placeholder',
        kind: 'email_due',
        lane: 'due_work',
        dueAt: '2026-09-21T14:00:00.000Z',
        status: 'open',
        automated: true,
        snoozeUntil: null,
      },
      {
        itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        contactName: 'Bailey Placeholder',
        kind: 'email_due',
        lane: 'due_work',
        dueAt: '2026-09-21T15:00:00.000Z',
        status: 'snoozed',
        automated: false,
        snoozeUntil: '2026-09-24T13:00:00.000Z',
      },
      {
        itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        contactId: null,
        contactName: null,
        kind: 'new_firm',
        lane: 'new_firm',
        dueAt: '2026-09-21T16:00:00.000Z',
        status: 'open',
        automated: false,
        snoozeUntil: null,
      },
    ],
    routes: [
      { routeId: ROUTE_ID, contactId: null, e164: '+14015550187', version: 3, eligibility: 'usable' },
      { routeId: OTHER_FIRM_ID, contactId: null, e164: '+14015550188', version: 1, eligibility: 'candidate' },
    ],
    callingIdentityId: IDENTITY_ID,
    ...overrides,
  };
}

/**
 * Four firms, one per lane, in the order the snapshot put them. The new firm's instant
 * is three weeks earlier than every other and it is still last: the lane decides, and
 * the page never re-sorts what the snapshot ordered.
 */
export function todayState(overrides: Partial<TodayState> = {}): TodayState {
  return {
    snapshotDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: REPLY_FIRM_ID,
        firmName: 'Ashgrove Test Partners',
        lane: 'reply',
        dueAt: '2026-09-21T11:42:00.000Z',
        counts: { replies: 1, emailsDue: 0, callsDue: 0 },
      },
      {
        firmId: FIRM_ID,
        firmName: 'Northwind Test Holdings',
        lane: 'callback',
        dueAt: '2026-09-21T18:00:00.000Z',
        counts: { replies: 0, emailsDue: 3, callsDue: 1 },
      },
      {
        firmId: DUE_FIRM_ID,
        firmName: 'Copperline Test Holdings',
        lane: 'due_work',
        dueAt: '2026-09-21T13:00:00.000Z',
        counts: { replies: 0, emailsDue: 1, callsDue: 0 },
      },
      {
        firmId: OTHER_FIRM_ID,
        firmName: 'Larkspur Test Foundry',
        lane: 'new_firm',
        dueAt: '2026-09-01T12:00:00.000Z',
        counts: { replies: 0, emailsDue: 0, callsDue: 0 },
      },
    ],
    expanded: null,
    online: true,
    stale: false,
    asOf: '2026-09-21T13:00:00.000Z',
    mayMutate: true,
    role: 'admin',
    notice: null,
    handoffNotice:
      'Once a call is handed to the phone app, Callie cannot recall it. A suppression recorded after that point applies to the next call, not this one.',
    ...overrides,
  };
}

export function connectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return {
    status: { connected: true, mailbox: { emailAddress: MAILBOX_ADDRESS, status: 'connected', syncState: 'ready' } },
    connecting: false,
    mayConnect: true,
    notice: null,
    ...overrides,
  };
}

export function notConnectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return { status: { connected: false, mailbox: null }, connecting: false, mayConnect: true, notice: null, ...overrides };
}

/** The number Today calls from: verified, enabled, and chosen by the server. */
export function callingNumber(overrides: Partial<CallingNumberView> = {}): CallingNumberView {
  return {
    id: IDENTITY_ID,
    e164: '+16175550100',
    label: 'Mobile',
    verificationStatus: 'verified',
    enabled: true,
    verifiedAt: '2026-09-25T12:00:00.000Z',
    verificationMethod: 'owner_attestation',
    disabledAt: null,
    usedForCalls: true,
    ...overrides,
  };
}

/**
 * Everything in order: an admin with a calling number, a domain whose checklist passes,
 * and no alert open. Each spec takes one thing away.
 */
export function readyAdmin(overrides: Partial<AdminState> = {}): AdminState {
  const posture = sendingPosture();
  return adminState({
    callingNumbers: [callingNumber()],
    sendingAdmin: {
      ...posture,
      domain: posture.domain === null ? null : { ...posture.domain, dmarcPass: true, postmasterReviewedAt: '2026-09-24T12:00:00.000Z', authenticationPasses: true },
    },
    ...overrides,
  });
}

export { dashboard, diagnostics, sendingPosture };

/** `callieToday`, scripted: the outcomes G6's Today window specs used. What each proves is in the spec. */
export function todayAnswer(state: TodayState, method: string, argument: unknown, _calls: readonly Call[]): TodayState {
  if (method === 'expand') {
    const firmId = (argument as { firmId?: string } | null)?.firmId;
    return { ...state, expanded: firmId === FIRM_ID ? expandedFirm() : null, notice: null };
  }
  if (method === 'collapse') return { ...state, expanded: null, notice: null };
  if (method === 'snooze') {
    const itemId = (argument as { itemId?: string } | null)?.itemId;
    // 8.2: the *server* decides which of the two a task gets, from its own `automated`
    // column. The page asked for the same thing both times.
    return { ...state, notice: itemId === AUTOMATED_ITEM_ID ? 'held' : 'snoozed' };
  }
  if (method === 'dial') return { ...state, notice: 'dial_opened' };
  if (method === 'recordOutcome') {
    // Lane g79: a callback request with no day comes back recorded with its follow-up,
    // as the real bridge reports the server's `followUps`.
    const input = argument as { outcome?: string; callback?: unknown } | null;
    const needsTime = input?.outcome === 'callback_requested' && input.callback === null;
    return { ...state, notice: needsTime ? 'outcome_recorded_callback_time_needed' : 'outcome_recorded' };
  }
  if (method === 'scheduleCallback') return { ...state, notice: 'callback_scheduled' };
  if (method === 'releasePause') return { ...state, notice: 'pause_released' };
  return state;
}
