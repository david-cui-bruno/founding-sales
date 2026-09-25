import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_THRESHOLDS, type DashboardResponse } from '@fss/contracts';
import {
  CHECKING,
  FIGURES_LABEL,
  FIGURES_UNREAD,
  HOME_EMPTY,
  NAV_ROWS,
  NOTHING_NEEDS_YOU,
  UNAVAILABLE,
  buildHomeView,
  businessDateHeading,
  dueLabel,
  figuresView,
  figuresWindow,
  laneSections,
  maskedNumber,
  needsRows,
  RESTART_TO_UPDATE,
  statusRows,
  updateLine,
  summaryLine,
  type FiguresRead,
  type HomeInput,
} from '../src/renderer/homeView.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';
import type { DesktopState, MailboxState } from '../src/shared/contract.ts';
import type { AdminState, CallingNumberView } from '../src/renderer/settingsContract.ts';
import type { TodayCard, TodayState } from '../src/renderer/todayContract.ts';

/**
 * Home's view model (lane g65; specification 8.2, 13.4, 14.2).
 *
 * Pure, so the decisions worth asserting are assertions: which status each fact reads
 * as, which Needs-you row each fact raises and which it never raises, what the figures
 * say when a source is `available: false` or the read failed, the business date on
 * both sides of a DST change, and what Home says in place of a bridge it was built
 * without.
 *
 * Fictional data only: `example.test` is reserved by RFC 6761 and the numbers are in the
 * NANP 555-01XX block.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

function card(overrides: Partial<TodayCard> & Pick<TodayCard, 'firmId' | 'lane'>): TodayCard {
  return {
    firmName: `Firm ${overrides.firmId.slice(0, 4)}`,
    dueAt: '2026-09-25T13:00:00.000Z',
    counts: { replies: 0, emailsDue: 0, callsDue: 0 },
    ...overrides,
  };
}

const CARDS: readonly TodayCard[] = [
  card({ firmId: 'a0000000-0000-4000-8000-000000000001', lane: 'reply', counts: { replies: 2, emailsDue: 0, callsDue: 0 } }),
  card({ firmId: 'a0000000-0000-4000-8000-000000000002', lane: 'callback', counts: { replies: 0, emailsDue: 1, callsDue: 1 } }),
  card({ firmId: 'a0000000-0000-4000-8000-000000000003', lane: 'due_work', counts: { replies: 0, emailsDue: 2, callsDue: 0 } }),
  card({ firmId: 'a0000000-0000-4000-8000-000000000004', lane: 'due_work', counts: { replies: 0, emailsDue: 0, callsDue: 1 } }),
  // Three weeks earlier than all the others, and last: the lane decides.
  card({ firmId: 'a0000000-0000-4000-8000-000000000005', lane: 'new_firm', dueAt: '2026-09-04T12:00:00.000Z' }),
];

function today(overrides: Partial<TodayState> = {}): TodayState {
  return {
    snapshotDate: '2026-09-25',
    businessTimeZone: 'America/New_York',
    cards: [...CARDS],
    expanded: null,
    online: true,
    stale: false,
    asOf: '2026-09-25T09:05:00.000Z',
    mayMutate: true,
    role: 'admin',
    notice: null,
    handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
    ...overrides,
  };
}

function desktop(role: 'admin' | 'salesperson' = 'admin', overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    screen: 'today',
    clientVersion: '1.0.3',
    supportedClientVersions: { minimum: '1.0.0', maximum: '1.0.3' },
    device: {
      deviceId: '33333333-3333-4333-8333-333333333333',
      deviceLabel: 'Test Mac',
      workspaceId: WORKSPACE,
      role,
      registeredAt: '2026-09-21T09:00:00.000Z',
    },
    online: true,
    stale: false,
    asOf: '2026-09-25T09:05:00.000Z',
    mayMutate: true,
    notice: null,
    today: { workspaceId: WORKSPACE, snapshotDate: '2026-09-25', businessTimeZone: 'America/New_York', cards: [...CARDS] },
    ...overrides,
  };
}

const connected: MailboxState = {
  status: { connected: true, mailbox: { emailAddress: 'sales@example.test', status: 'connected', syncState: 'ready' } },
  connecting: false,
  mayConnect: true,
  notice: null,
};
const notConnected: MailboxState = { status: { connected: false, mailbox: null }, connecting: false, mayConnect: true, notice: null };

function number(overrides: Partial<CallingNumberView> = {}): CallingNumberView {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    e164: '+16175550100',
    label: null,
    verificationStatus: 'verified',
    enabled: true,
    verifiedAt: '2026-09-25T12:00:00.000Z',
    verificationMethod: 'owner_attestation',
    disabledAt: null,
    usedForCalls: true,
    ...overrides,
  };
}

const passingDomain = {
  domain: 'sending.example.test',
  spfPass: true,
  dkimPass: true,
  dmarcPass: true,
  postmasterReviewedAt: '2026-09-24T12:00:00.000Z',
  authenticationPasses: true,
  automatedSendingEnabled: false,
  personalGmailGuardPer24h: 4000,
};

function admin(overrides: Partial<AdminState> = {}): AdminState {
  return {
    screen: 'settings',
    role: 'admin',
    online: true,
    mayMutate: true,
    notice: null,
    settings: {
      settings: [
        { settingKey: 'alert_thresholds', value: DEFAULT_ALERT_THRESHOLDS, version: 0, changedAt: null, changedByUserId: null, changeNote: null },
      ],
      elsewhere: [],
      holidayCalendar: { version: 'none.1', dates: [] },
      deploymentSendingEnabled: true,
      effectiveSendingEnabled: false,
    },
    dashboard: null,
    diagnostics: null,
    stages: [],
    history: null,
    sendingAdmin: { domain: passingDomain, personalGmailRecipients: 0, ramps: [] },
    sendingReadError: null,
    callingNumbers: [number()],
    ...overrides,
  };
}

const WINDOW = { from: '2026-09-18T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' };

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    window: WINDOW,
    audience: 'workspace',
    firmsInScope: 5,
    messages: { incomingMatched: 6, human: 4, uncertain: 2, automated: 0, bounces: 0, optOuts: 0 },
    replyHandling: { replies: 4, handled: 3, medianSecondsToHandle: 600, slowestSecondsToHandle: 1200 },
    calls: [
      { key: 'voicemail_left', count: 3 },
      { key: 'interested', count: 2 },
    ],
    stageMovement: [],
    holds: { open: 3, byReason: [] },
    suppressions: [],
    sending: { available: false, owner: 'G7-2', reason: 'not in this build' },
    enrollments: { available: false, owner: 'G8', reason: 'not in this build' },
    classifier: { available: false, owner: 'G7b', reason: 'not in this build' },
    ...overrides,
  } as DashboardResponse;
}

const read = (value: DashboardResponse | null): FiguresRead => ({ requested: WINDOW, answered: true, dashboard: value });

function input(overrides: Partial<HomeInput> = {}): HomeInput {
  const state = overrides.today === undefined ? today() : overrides.today;
  return {
    desktop: desktop(),
    bridges: { today: true, mailbox: true, admin: true },
    today: state,
    todayView: state === null ? null : buildTodayView(state),
    mailbox: connected,
    mailboxWaiting: false,
    admin: admin(),
    figures: read(dashboard()),
    ...overrides,
  };
}

const status = (value: HomeInput, key: string): { tone: string; text: string } | undefined =>
  statusRows(value).find(row => row.key === key);
const needs = (value: HomeInput): string[] => needsRows(value).map(row => row.key);

describe('the business-date heading', () => {
  it('names the snapshot date in words', () => {
    expect(businessDateHeading('2026-09-25', 'America/New_York')).toBe('Friday, 25 September');
  });

  it('reads the date in the business zone on both sides of a DST change', () => {
    // Midnight UTC on these Sundays is Saturday evening in New York, and noon UTC is
    // already Saturday the 26th in Kiritimati: only reading the date in its own zone gets
    // every one of them right.
    expect(businessDateHeading('2026-03-08', 'America/New_York')).toBe('Sunday, 8 March');
    expect(businessDateHeading('2026-11-01', 'America/New_York')).toBe('Sunday, 1 November');
    expect(businessDateHeading('2026-10-31', 'America/New_York')).toBe('Saturday, 31 October');
    expect(businessDateHeading('2026-10-25', 'Europe/London')).toBe('Sunday, 25 October');
    expect(businessDateHeading('2026-03-29', 'Europe/London')).toBe('Sunday, 29 March');
    expect(businessDateHeading('2026-09-25', 'Pacific/Kiritimati')).toBe('Friday, 25 September');
    expect(businessDateHeading('2026-09-25', 'Pacific/Pago_Pago')).toBe('Friday, 25 September');
  });

  it('says Today when there is no date to name, or no zone to read it in', () => {
    expect(businessDateHeading(null, 'America/New_York')).toBe('Today');
    expect(businessDateHeading('2026-09-25', null)).toBe('Today');
    expect(businessDateHeading('2026-09-25', 'Not/AZone')).toBe('Today');
  });

  it('reads a task’s instant as the business zone’s clock', () => {
    expect(dueLabel('2026-09-25T18:00:00.000Z', 'America/New_York', '2026-09-25')).toBe('14:00');
    expect(dueLabel('2026-09-24T13:00:00.000Z', 'America/New_York', '2026-09-25')).toBe('Thu 24 Sep, 09:00');
    expect(dueLabel('2026-09-25T18:00:00.000Z', null, '2026-09-25')).toBe('2026-09-25T18:00:00.000Z');
  });
});

describe('the lanes and the line of counts', () => {
  it('keeps the server’s order and starts a section wherever the lane changes', () => {
    const sections = laneSections(buildTodayView(today()).cards);
    expect(sections.map(section => section.label)).toEqual(['Replies', 'Callbacks', 'Due today', 'New firms']);
    expect(sections.map(section => section.cards.length)).toEqual([1, 1, 2, 1]);
    expect(sections.flatMap(section => section.cards.map(entry => entry.card.firmId))).toEqual(CARDS.map(entry => entry.firmId));
  });

  it('never repairs an order the server sent, even one 8.2 would not produce', () => {
    const [reply, callback] = CARDS;
    if (reply === undefined || callback === undefined) throw new Error('fixture');
    const odd = laneSections(buildTodayView(today({ cards: [callback, reply] })).cards);
    expect(odd.map(section => section.lane)).toEqual(['callback', 'reply']);
  });

  it('counts firms, replies and callbacks, and held emails only while sending is off', () => {
    expect(summaryLine(CARDS, false)).toBe('5 firms · 2 replies · 1 callback');
    expect(summaryLine(CARDS, true)).toBe('5 firms · 2 replies · 1 callback · 3 emails held');
    expect(summaryLine(CARDS.slice(4), true)).toBe('1 firm');
    expect(summaryLine([], true)).toBeNull();
    expect(buildHomeView(input(), []).summary).toBe('5 firms · 2 replies · 1 callback · 3 emails held');
  });

  it('says what to do next when the list is empty, and that it is checking before the first answer', () => {
    expect(buildHomeView(input({ today: today({ cards: [] }) }), []).lanes?.emptyLine).toBe(HOME_EMPTY);
    expect(HOME_EMPTY).toBe('Nothing today. Add firms and a sequence, and tomorrow’s list builds at 05:00.');
    // Offline with nothing cached is not "nothing today": it is the old sentence.
    expect(buildHomeView(input({ today: today({ cards: [], online: false }) }), []).lanes?.emptyLine).toBe(
      'Callie has no saved list for today.',
    );
    expect(buildHomeView(input({ today: null }), []).lanes?.emptyLine).toBe(CHECKING);
    expect(buildHomeView(input(), []).lanes?.emptyLine).toBeNull();
  });

  it('shows the lanes’ own offline and stale lines, and the session’s notice, each once', () => {
    const view = buildHomeView(
      input({ today: today({ online: false, stale: true, notice: 'snoozed' }), desktop: desktop('admin', { online: false, stale: true }) }),
      [
        { tone: 'warning', text: 'Callie cannot reach the server.' },
        { tone: 'info', text: 'It has been thirty days. Sign in with Google again.' },
      ],
    );
    expect(view.notices.map(notice => notice.text)).toEqual([
      'Callie cannot reach the server.',
      'This list is from an earlier read, at 2026-09-25T09:05:00.000Z. Nothing here can be changed until Callie reconnects.',
      'Snoozed.',
      'It has been thirty days. Sign in with Google again.',
    ]);
  });

  it('lists every window with the key the menu gives it, Today first and current', () => {
    expect(NAV_ROWS.map(row => `${row.label} ${row.keys}`)).toEqual([
      'Today ⌘1',
      'Replies ⌘2',
      'Firms ⌘3',
      'Sequences ⌘4',
      'Dashboard ⌘6',
      'Administration ⌘5',
    ]);
    expect(NAV_ROWS[0]?.window).toBeNull();
  });
});

describe('the sidebar’s status', () => {
  it('reads the mailbox as the server last said, or says it has not', () => {
    expect(status(input(), 'mailbox')).toEqual({ key: 'mailbox', tone: 'ok', text: 'Mailbox connected · sales@example.test' });
    expect(status(input({ mailbox: notConnected }), 'mailbox')).toMatchObject({ tone: 'warn', text: 'Mailbox not connected' });
    expect(
      status(input({ mailbox: { ...notConnected, status: { connected: false, mailbox: { emailAddress: 'sales@example.test', status: 'revoked', syncState: 'ready' } } } }), 'mailbox'),
    ).toMatchObject({ tone: 'warn', text: 'Mailbox not connected · sales@example.test' });
    expect(status(input({ mailbox: { ...notConnected, status: null } }), 'mailbox')).toMatchObject({ tone: 'none', text: 'Mailbox status unknown' });
    expect(status(input({ mailbox: null }), 'mailbox')).toMatchObject({ tone: 'none', text: 'Mailbox: checking…' });
  });

  it('names the number Today calls from, masked, and nothing it has not read', () => {
    expect(maskedNumber('+16175550100')).toBe('+1 617 ··· 0100');
    expect(maskedNumber('+447700900123')).toBe('+44 ··· 0123');
    expect(status(input(), 'calling')).toMatchObject({ tone: 'ok', text: 'Calling from +1 617 ··· 0100' });
    // The server chose none, and the person has none, or only retired ones.
    expect(status(input({ admin: admin({ callingNumbers: [] }) }), 'calling')).toMatchObject({ tone: 'warn', text: 'No calling number' });
    expect(
      status(input({ admin: admin({ callingNumbers: [number({ usedForCalls: false, enabled: false, disabledAt: '2026-09-25T13:00:00.000Z' })] }) }), 'calling'),
    ).toMatchObject({ tone: 'warn', text: 'No calling number' });
    expect(status(input({ admin: admin({ callingNumbers: null }) }), 'calling')).toMatchObject({ tone: 'none', text: 'Calling number not read' });
    expect(status(input({ admin: null }), 'calling')).toMatchObject({ tone: 'none', text: 'Calling number: checking…' });
  });

  // Until lane g69 this row read "No calling number" for a saved, unattested number,
  // which is what an unticked Add leaves: the person had a number, and Home said they
  // did not. The row now names what is missing — the attestation — in amber.
  it('says a saved but unattested number needs attestation rather than that there is no number (lane g69)', () => {
    const saved = number({ usedForCalls: false, verificationStatus: 'unverified', enabled: false, verifiedAt: null, verificationMethod: null });
    expect(status(input({ admin: admin({ callingNumbers: [saved] }) }), 'calling')).toEqual({
      key: 'calling',
      tone: 'warn',
      text: 'Calling number needs attestation',
    });
    // Beside a retired one, the saved one is still the one to attest.
    expect(
      status(input({ admin: admin({ callingNumbers: [number({ id: '55555555-5555-4555-8555-000000000002', usedForCalls: false, enabled: false, disabledAt: '2026-09-24T13:00:00.000Z' }), saved] }) }), 'calling'),
    ).toMatchObject({ text: 'Calling number needs attestation' });
  });

  it('reads sending from the server’s effective flag and never recombines it', () => {
    const base = admin();
    const settings = base.settings;
    if (settings === null) throw new Error('fixture');
    // The deployment half is on and the admin half off: the effective answer is off.
    expect(status(input(), 'sending')).toMatchObject({ tone: 'warn', text: 'Sending off' });
    expect(status(input({ admin: admin({ settings: { ...settings, effectiveSendingEnabled: true, deploymentSendingEnabled: false } }) }), 'sending')).toMatchObject({
      tone: 'ok',
      text: 'Sending on',
    });
    expect(status(input({ admin: admin({ settings: null }) }), 'sending')).toMatchObject({ tone: 'none', text: 'Sending not read' });
  });

  it('shows an admin the domain checklist and a salesperson no domain row at all', () => {
    expect(status(input(), 'domain')).toMatchObject({ tone: 'ok', text: 'Domain passes · sending.example.test' });
    expect(status(input({ admin: admin({ sendingAdmin: { domain: { ...passingDomain, dmarcPass: false, authenticationPasses: false }, personalGmailRecipients: 0, ramps: [] } }) }), 'domain')).toMatchObject({
      tone: 'warn',
      text: 'Domain checklist not passing · sending.example.test',
    });
    expect(status(input({ admin: admin({ sendingAdmin: { domain: null, personalGmailRecipients: 0, ramps: [] } }) }), 'domain')).toMatchObject({
      tone: 'warn',
      text: 'Domain checklist not recorded',
    });
    expect(status(input({ admin: admin({ sendingAdmin: null }) }), 'domain')).toMatchObject({ tone: 'none', text: 'Domain not read' });
    expect(status(input({ desktop: desktop('salesperson') }), 'domain')).toBeUndefined();
    expect(status(input({ desktop: desktop('salesperson'), admin: null }), 'domain')).toBeUndefined();
  });

  it('says the version, and whether the list is live, stale or offline', () => {
    expect(status(input(), 'system')).toMatchObject({ tone: 'ok', text: 'Callie 1.0.3 · online' });
    expect(status(input({ today: today({ stale: true }) }), 'system')).toMatchObject({ tone: 'warn', text: 'Callie 1.0.3 · list is stale' });
    expect(status(input({ today: today({ online: false, stale: true }) }), 'system')).toMatchObject({ tone: 'stop', text: 'Callie 1.0.3 · offline' });
    // Without the lanes' state, the session's own flags.
    expect(status(input({ today: null, desktop: desktop('admin', { online: false }) }), 'system')).toMatchObject({ tone: 'stop' });
  });
});

describe('Needs you', () => {
  it('asks for nothing when everything is in order', () => {
    expect(needs(input())).toEqual([]);
    expect(buildHomeView(input(), []).needsLine).toBe(NOTHING_NEEDS_YOU);
  });

  it('offers Connect Gmail only for a mailbox read as not connected, with the row’s own control', () => {
    const rows = needsRows(input({ mailbox: notConnected }));
    expect(rows).toEqual([
      { key: 'connect_gmail', label: 'Connect Gmail', detail: null, action: { kind: 'connect_mailbox', label: 'Connect Gmail', enabled: true } },
    ]);
    expect(needs(input({ mailbox: connected }))).toEqual([]);
    // Unread is not "not connected": a blind second grant is exactly what the row avoids.
    expect(needs(input({ mailbox: null }))).toEqual([]);
    expect(needs(input({ mailbox: { ...notConnected, status: null } }))).toEqual([]);
    expect(needs(input({ mailbox: notConnected, bridges: { today: true, mailbox: false, admin: true } }))).toEqual([]);
  });

  it('follows the Mailbox row: disabled offline, waiting while the browser has the person, the refusal as its detail', () => {
    expect(needsRows(input({ mailbox: { ...notConnected, mayConnect: false, notice: 'offline' } }))[0]).toMatchObject({
      detail: 'Callie cannot reach the server.',
      action: { enabled: false },
    });
    expect(needsRows(input({ mailbox: notConnected, mailboxWaiting: true }))[0]).toMatchObject({
      action: { label: 'Waiting for your browser…', enabled: false },
    });
  });

  it('asks for a calling number when none is the one Today calls from, and opens Administration', () => {
    expect(needsRows(input({ admin: admin({ callingNumbers: [] }) }))).toEqual([
      { key: 'calling_number', label: 'Add your calling number', detail: null, action: { kind: 'open', window: 'administration', label: 'Open' } },
    ]);
    expect(needs(input({ admin: admin({ callingNumbers: [number({ usedForCalls: false, enabled: false, disabledAt: '2026-09-25T13:00:00.000Z' })] }) }))).toEqual([
      'calling_number',
    ]);
    expect(needs(input({ admin: admin({ callingNumbers: [number()] }) }))).toEqual([]);
    // A list that was not read is not an empty list.
    expect(needs(input({ admin: admin({ callingNumbers: null }) }))).toEqual([]);
  });

  it('asks a person with a saved, unattested number to attest it, not to add another (lane g69)', () => {
    // What an unticked Add leaves: registered, unverified, disabled, not retired.
    const saved = number({ usedForCalls: false, verificationStatus: 'unverified', enabled: false, verifiedAt: null, verificationMethod: null });
    expect(needsRows(input({ admin: admin({ callingNumbers: [saved] }) }))).toEqual([
      {
        key: 'calling_number',
        label: 'Attest your calling number',
        detail: 'Your number is saved. Open Your calling number and attest it.',
        // Administration opens on Settings, where the saved row has its own Attest.
        action: { kind: 'open', window: 'administration', label: 'Open' },
      },
    ]);
    // A saved number beside a retired one: attest the saved one.
    const retired = number({ id: '55555555-5555-4555-8555-000000000002', usedForCalls: false, enabled: false, disabledAt: '2026-09-24T13:00:00.000Z' });
    expect(needsRows(input({ admin: admin({ callingNumbers: [retired, saved] }) }))[0]?.label).toBe('Attest your calling number');
  });

  it('asks a person whose every number is retired to re-attest one (lane g69)', () => {
    const retired = number({ usedForCalls: false, enabled: false, disabledAt: '2026-09-25T13:00:00.000Z' });
    expect(needsRows(input({ admin: admin({ callingNumbers: [retired] }) }))).toEqual([
      {
        key: 'calling_number',
        label: 'Re-attest your calling number',
        detail: 'Your number was retired. Open Your calling number and attest it again.',
        action: { kind: 'open', window: 'administration', label: 'Open' },
      },
    ]);
  });

  it('asks an admin to record the domain checklist when it is missing or does not pass', () => {
    const failing = { domain: { ...passingDomain, spfPass: false, authenticationPasses: false }, personalGmailRecipients: 0, ramps: [] };
    expect(needs(input({ admin: admin({ sendingAdmin: failing }) }))).toEqual(['domain_checklist']);
    expect(needs(input({ admin: admin({ sendingAdmin: { domain: null, personalGmailRecipients: 0, ramps: [] } }) }))).toEqual(['domain_checklist']);
    expect(needs(input({ admin: admin({ sendingAdmin: null }) }))).toEqual([]);
    expect(needsRows(input({ admin: admin({ sendingAdmin: failing }) }))[0]?.action).toEqual({
      kind: 'open',
      window: 'administration',
      label: 'Open',
    });
  });

  it('never tells a salesperson about the domain or the alerts, whatever the bridge holds', () => {
    const failing = { domain: { ...passingDomain, authenticationPasses: false }, personalGmailRecipients: 0, ramps: [] };
    const alerts = {
      alerts: [{ id: '66666666-6666-4666-8666-666666666666', alertKey: 'canary_stale', severity: 'critical' as const, raisedAt: '2026-09-25T10:00:00.000Z', acknowledgedAt: null, runbookPath: null }],
    };
    const seen = input({
      desktop: desktop('salesperson'),
      admin: admin({ role: 'salesperson', sendingAdmin: failing, diagnostics: alerts as unknown as AdminState['diagnostics'] }),
    });
    expect(needs(seen)).toEqual([]);
    expect(buildHomeView(seen, []).needsLine).toBe(NOTHING_NEEDS_YOU);
  });

  it('counts an admin’s unacknowledged alerts from a Diagnostics read the bridge already holds', () => {
    const alert = (id: string, acknowledgedAt: string | null) => ({
      id,
      alertKey: 'canary_stale',
      severity: 'warning' as const,
      raisedAt: '2026-09-25T10:00:00.000Z',
      acknowledgedAt,
      runbookPath: null,
    });
    const holding = (list: readonly ReturnType<typeof alert>[]) =>
      input({ admin: admin({ diagnostics: { alerts: list } as unknown as AdminState['diagnostics'] }) });
    expect(needsRows(holding([alert('66666666-6666-4666-8666-000000000001', null), alert('66666666-6666-4666-8666-000000000002', null), alert('66666666-6666-4666-8666-000000000003', '2026-09-25T11:00:00.000Z')]))).toEqual([
      { key: 'alerts', label: '2 alerts to acknowledge', detail: null, action: { kind: 'open', window: 'administration', label: 'Open' } },
    ]);
    expect(needsRows(holding([alert('66666666-6666-4666-8666-000000000001', null)]))[0]?.label).toBe('1 alert to acknowledge');
    expect(needs(holding([alert('66666666-6666-4666-8666-000000000003', '2026-09-25T11:00:00.000Z')]))).toEqual([]);
    expect(needs(input({ admin: admin({ diagnostics: null }) }))).toEqual([]);
  });

  it('lists every need at once, in a fixed order', () => {
    expect(
      needs(
        input({
          mailbox: notConnected,
          admin: admin({
            callingNumbers: [],
            sendingAdmin: { domain: null, personalGmailRecipients: 0, ramps: [] },
            diagnostics: { alerts: [{ id: '66666666-6666-4666-8666-000000000001', alertKey: 'x', severity: 'critical', raisedAt: '2026-09-25T10:00:00.000Z', acknowledgedAt: null, runbookPath: null }] } as unknown as AdminState['diagnostics'],
          }),
        }),
      ),
    ).toEqual(['connect_gmail', 'calling_number', 'domain_checklist', 'alerts']);
  });

  it('says it is checking before the bridges answer', () => {
    expect(buildHomeView(input({ admin: null }), []).needsLine).toBe(CHECKING);
    expect(buildHomeView(input({ mailbox: null }), []).needsLine).toBe(CHECKING);
  });
});

describe('the last 7 days', () => {
  it('is labelled by its real window and covers exactly seven days', () => {
    const window = figuresWindow(new Date('2026-09-25T12:00:00.000Z'));
    expect(window).toEqual({ from: '2026-09-18T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' });
    expect(figuresView({ admin: true, figures: read(dashboard()) }).label).toBe(FIGURES_LABEL);
    expect(FIGURES_LABEL).toBe('Last 7 days');
  });

  it('shows replies with uncertain, calls summed, holds open, and a dash for sending not in this build', () => {
    expect(figuresView({ admin: true, figures: read(dashboard()) })).toEqual({
      label: 'Last 7 days',
      cells: [
        { key: 'replies', label: 'Replies', value: '4', note: '2 uncertain' },
        { key: 'calls', label: 'Calls', value: '5', note: null },
        { key: 'holds', label: 'Holds open', value: '3', note: null },
        { key: 'emails', label: 'Emails sent', value: '—', note: 'not in this build' },
      ],
      line: null,
    });
  });

  it('shows emails sent, and held, when sending is in the build', () => {
    const view = figuresView({
      admin: true,
      figures: read(dashboard({ sending: { available: true, sent: 12, held: 4 } as unknown as DashboardResponse['sending'] })),
    });
    expect(view.cells[3]).toEqual({ key: 'emails', label: 'Emails sent', value: '12', note: '4 held' });
  });

  it('is dashes and one grey line when the read failed or answered for another window', () => {
    const dashes = ['—', '—', '—', '—'];
    const failed = figuresView({ admin: true, figures: read(null) });
    expect(failed.cells.map(cell => cell.value)).toEqual(dashes);
    expect(failed.line).toBe(FIGURES_UNREAD);
    // The bridge keeps its last figures when a read fails, and those may be
    // Administration's thirty days. They are not these.
    const other = figuresView({
      admin: true,
      figures: read(dashboard({ window: { from: '2026-08-26T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' } })),
    });
    expect(other.cells.map(cell => cell.value)).toEqual(dashes);
    expect(other.line).toBe(FIGURES_UNREAD);
    // The same instants written differently are the same window.
    expect(figuresView({ admin: true, figures: read(dashboard({ window: { from: '2026-09-18T12:00:00Z', to: '2026-09-25T12:00:00Z' } })) }).line).toBeNull();
  });

  it('is dashes with no line while the read is in flight', () => {
    const view = figuresView({ admin: true, figures: { requested: WINDOW, answered: false, dashboard: null } });
    expect(view.cells.map(cell => cell.value)).toEqual(['—', '—', '—', '—']);
    expect(view.line).toBeNull();
  });
});

describe('a page built without a bridge', () => {
  it('says Unavailable in this build wherever that bridge would have answered', () => {
    const view = buildHomeView(
      input({ bridges: { today: false, mailbox: false, admin: false }, today: null, mailbox: null, admin: null, figures: { requested: null, answered: false, dashboard: null } }),
      [],
    );
    expect(view.lanes).toBeNull();
    expect(view.summary).toBeNull();
    // The session still carries the cached list's date.
    expect(view.heading).toBe('Friday, 25 September');
    expect(view.figures.line).toBe(UNAVAILABLE);
    expect(view.needs).toEqual([]);
    expect(view.needsLine).toBe(UNAVAILABLE);
    expect(view.status.map(row => row.text)).toEqual([
      'Mailbox: unavailable in this build',
      'Calling number: unavailable in this build',
      'Sending: unavailable in this build',
      'Domain: unavailable in this build',
      'Callie 1.0.3 · online',
    ]);
  });

  it('keeps what the present bridges know when only one is missing', () => {
    const view = buildHomeView(input({ bridges: { today: true, mailbox: true, admin: false }, mailbox: notConnected }), []);
    expect(view.needs.map(row => row.key)).toEqual(['connect_gmail']);
    expect(view.lanes?.sections).toHaveLength(4);
    expect(view.figures.line).toBe(UNAVAILABLE);
  });
});

// Lane g83: one line under the version while an update is installing or staged.
describe('the update line', () => {
  it('draws nothing when there is nothing to say, or no bridge to say it', () => {
    expect(statusRows(input()).map(row => row.key)).not.toContain('update');
    expect(statusRows(input({ update: null })).map(row => row.key)).not.toContain('update');
    expect(statusRows(input({ update: { kind: 'none' } })).map(row => row.key)).not.toContain('update');
  });

  it('says an install is under way, with nothing to press', () => {
    const rows = statusRows(input({ update: { kind: 'installing', version: '1.0.6' } }));
    expect(rows.at(-1)).toEqual({ key: 'update', tone: 'none', text: 'Updating Callie to 1.0.6…' });
    expect(rows.at(-2)?.key).toBe('system');
    expect(rows.filter(row => row.action !== undefined)).toEqual([]);
  });

  it('offers Restart to update once a verified update is staged, and nowhere else', () => {
    const rows = statusRows(input({ update: { kind: 'ready', version: '1.0.6' } }));
    expect(rows.at(-1)).toEqual({ key: 'update', tone: 'none', text: 'Callie 1.0.6 is ready', action: 'restart_to_update' });
    expect(rows.filter(row => row.action !== undefined)).toHaveLength(1);
    expect(RESTART_TO_UPDATE).toBe('Restart to update');
    expect(updateLine({ kind: 'ready', version: '1.0.6' })).toBe('Callie 1.0.6 is ready');
    expect(updateLine({ kind: 'none' })).toBeNull();
  });
});
