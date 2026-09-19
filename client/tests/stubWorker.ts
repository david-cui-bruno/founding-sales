import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TERRITORY_CLEARANCE_STATEMENTS, TERRITORY_RULES_REVISION, TERRITORY_STATE_RULES } from '../../src/shared/contracts/territoryClearanceContract';
import {
  attemptKindSchema,
  DIAGNOSTICS_ATTEMPT_LIMIT,
  diagnosticsViewSchema,
  pairRedeemRequestSchema,
  pairRedeemResponseSchema,
  settingsViewSchema,
  todayViewSchema,
  v1CommandReceiptSchema,
  v1CommandSchema,
  v1FirmViewSchema,
  weekViewSchema,
  type AttemptRecord,
  type CallPolicyView,
  type DiagnosticsDevice,
  type PausedView,
  type PhoneSetupView,
  type SettingsView,
  type StatePostureSummary,
  type TodayCard,
  type TodayLane,
  type TodayView,
  type V1Command,
  type V1FirmView,
  type WeekView,
} from '../../src/shared/contracts/v1Contract';

/**
 * A stub of the worker's `/v1` routes for the Playwright specs, built from fixtures through the shared
 * zod schemas so it cannot drift from the contract. Every code and every device token is generated at
 * runtime: there is no literal token-shaped string anywhere in this file. It listens on the loopback
 * interface over plain http, which is the one exception the client's endpoint rule admits.
 *
 * What a spec can do with it: mint codes, read the fixture it serves, expire or revoke the paired device
 * (the next authenticated request then gets the 401 with that reason), and inspect every request and
 * command the client sent.
 *
 * Slice S2 gave it the Firm view and the two commands a card issues. `log_call_outcome` is applied the way the
 * worker applies it, to the degree the specs need: the card gains the outcome and the note, a promised callback
 * appears on it, and a never-call or an opt-out takes the firm off the list for good and answers with no card.
 */
const secret = () => randomBytes(32).toString('base64url');
const PAIR_CODE = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const instant = (offsetMinutes: number) => new Date(NOW - offsetMinutes * 60_000).toISOString();
const ninetyDaysAfter = (createdAt: string) => new Date(Date.parse(createdAt) + 90 * 24 * 3_600_000).toISOString();

export type StubRequest = { method: string; path: string; query: URLSearchParams; authenticated: boolean };
export type PairedDevice = { deviceId: string; label: string; token: string; createdAt: string; expired: boolean; revoked: boolean };

export type StubWorker = {
  url: string;
  asOf: string;
  today: TodayView;
  /** The Firm view the stub serves for one firm, built from the card it is showing. */
  firmView(firmId: string): V1FirmView | null;
  /** Replace the Today answer (a contract-valid view) for the next reads. */
  setToday(view: TodayView): void;
  /** The postures the stub holds after the `set_state_posture` commands the client sent, by state. */
  postures(): StatePostureSummary[];
  requests: StubRequest[];
  commands: V1Command[];
  mintCode(label: string): string;
  unknownCode(): string;
  writeCodeFile(label: string, directory: string): Promise<string>;
  attempts(kind?: string): AttemptRecord[];
  pairedDevices(): PairedDevice[];
  otherDevices(): DiagnosticsDevice[];
  expireDevice(deviceId: string): void;
  revokeDevice(deviceId: string): void;
  close(): Promise<void>;
};

/** Twenty attempts, newest first, over every kind, with closed details as the worker records them. */
function attemptFixture(): AttemptRecord[] {
  const commandId = () => randomUUID();
  const rows: Omit<AttemptRecord, 'at'>[] = [
    { kind: 'command', outcome: 'ok', reason: null, detail: { code: 'revoke_device', commandId: commandId() }, durationMs: 41, ref: null },
    { kind: 'tick', outcome: 'ok', reason: null, detail: { code: 'completed', count: 4 }, durationMs: 1830, ref: null },
    { kind: 'tick_phase', outcome: 'held', reason: 'mailbox_not_connected', detail: { code: 'mailbox_not_connected' }, durationMs: 12, ref: 'poll' },
    { kind: 'events_page', outcome: 'ok', reason: null, detail: { code: 'page', cursor: 'a1b2c3d4e5f6', count: 200, bytes: 51200 }, durationMs: 220, ref: null },
    { kind: 'send', outcome: 'ok', reason: null, detail: { code: 'accepted', firmId: 'account-0001', jobId: 'send:account-0001:T1' }, durationMs: 940, ref: null },
    { kind: 'hold', outcome: 'held', reason: 'cap_reached', detail: { code: 'cap_reached', firmId: 'account-0002' }, durationMs: null, ref: null },
    { kind: 'command', outcome: 'failed', reason: 'command_conflict', detail: { code: 'revoke_device', commandId: commandId() }, durationMs: 30, ref: null },
    { kind: 'research', outcome: 'failed', reason: 'provider_error', detail: { code: 'provider_error', providerStatus: 429, providerCode: 'rate_limited' }, durationMs: 3200, ref: null },
    { kind: 'poll', outcome: 'ok', reason: null, detail: { code: 'polled', count: 3 }, durationMs: 610, ref: null },
    { kind: 'pairing', outcome: 'ok', reason: null, detail: { code: 'device_paired' }, durationMs: 88, ref: null },
    { kind: 'command', outcome: 'ok', reason: 'duplicate', detail: { code: 'revoke_device', commandId: commandId() }, durationMs: 15, ref: null },
    { kind: 'tick_phase', outcome: 'ok', reason: null, detail: { code: 'research', count: 2 }, durationMs: 480, ref: 'research' },
    { kind: 'tick', outcome: 'aborted', reason: 'budget_exhausted', detail: { code: 'budget_exhausted' }, durationMs: 300_000, ref: null },
    { kind: 'send', outcome: 'held', reason: 'template_not_approved', detail: { code: 'template_not_approved', firmId: 'account-0003' }, durationMs: null, ref: null },
    { kind: 'pairing', outcome: 'failed', reason: 'code_unknown', detail: null, durationMs: 5, ref: null },
    { kind: 'events_page', outcome: 'ok', reason: null, detail: { code: 'page', cursor: 'f6e5d4c3b2a1', count: 17, bytes: 4096 }, durationMs: 90, ref: null },
    { kind: 'hold', outcome: 'held', reason: 'outside_hours', detail: { code: 'outside_hours', firmId: 'account-0004' }, durationMs: null, ref: null },
    { kind: 'research', outcome: 'ok', reason: null, detail: { code: 'researched', firmId: 'account-0005', bytes: 120_000 }, durationMs: 4100, ref: null },
    { kind: 'command', outcome: 'failed', reason: 'device_unknown', detail: { code: 'revoke_device', commandId: commandId() }, durationMs: 22, ref: null },
    { kind: 'poll', outcome: 'failed', reason: 'provider_error', detail: { code: 'provider_error', providerStatus: 503 }, durationMs: 15_000, ref: null },
  ];
  if (rows.length !== DIAGNOSTICS_ATTEMPT_LIMIT) throw new Error('fixture must hold exactly the diagnostics limit');
  return rows.map((row, index) => ({ at: instant(index * 7), ...row }));
}

/** One card of the morning list; every number stays outside the refused 555-01XX block, every name and place is fictional. */
function card(over: Partial<TodayCard> & Pick<TodayCard, 'firmId' | 'lane' | 'reason' | 'name'>): TodayCard {
  return {
    phone: { number: '+14015550201', verification: 'listed' }, website: 'fictional-firm.example', city: 'Providence', state: 'RI', timeZone: 'America/New_York',
    localTime: '09:30', openNow: true, dialAllowed: true, holdReason: null, holdCode: null,
    offer: 'A short introductory call about how your firm handles resident maintenance requests.', lastOutcome: null, nextStep: { kind: 'first_call' }, ...over,
  };
}

/** The built morning list the stub serves: one reply, no callbacks, one due call held outside hours, two new firms; MA and TX have firms and no posture. */
export function todayFixture(): TodayView {
  return todayViewSchema.parse({
    asOf: new Date(NOW).toISOString(),
    list: {
      header: {
        date: '2026-09-18', builtAt: instant(7 * 60), poolSize: 2, counts: { replies: 1, callbacks: 0, due: 1, new: 2 },
        holds: [{ reason: 'state_not_cleared', code: 'no_posture', count: 3 }], excluded: { no_posture: 3 },
        lastTick: { at: instant(3), status: 'completed', durationMs: 1830 },
        postures: [{ state: 'RI', posture: 'calling', decidedAt: instant(60 * 24 * 8), decidedBy: 'David MacBook', reviewAt: ninetyDaysAfter(instant(60 * 24 * 8)), reviewOverdue: false }],
        statesWithoutPosture: ['MA', 'TX'],
      },
      lanes: {
        replies: [card({ firmId: 'account-reply-1', lane: 'replies', reason: 'reply_waiting', name: 'Replied Property Group', nextStep: { kind: 'reply' } })],
        callbacks: [],
        due: [card({ firmId: 'account-tx-1', lane: 'due', reason: 'step_due', name: 'Lone Star Living', phone: { number: '+15125550271', verification: 'listed' }, city: 'Austin', state: 'TX',
          timeZone: 'America/Chicago', localTime: '06:00', openNow: false, dialAllowed: false, holdReason: 'outside_hours', holdCode: 'outside_hours',
          lastOutcome: { outcome: 'voicemail', at: instant(60 * 24 * 3), note: null }, nextStep: { kind: 'call', stepIndex: 1, stepCount: 5, dueAt: instant(-60) } })],
        new: [card({ firmId: 'account-ri-1', lane: 'new', reason: 'new_firm', name: 'Rhode Island Firm 1' }),
          card({ firmId: 'account-ri-2', lane: 'new', reason: 'new_firm', name: 'Rhode Island Firm 2', phone: { number: '+14015550202', verification: 'published' } })],
      },
    },
  });
}

/** Twelve months after an instant, same UTC day and time; what the worker's posture module writes as reviewAt. */
export function twelveMonthsAfter(instantIso: string): string {
  const date = new Date(Date.parse(instantIso));
  date.setUTCMonth(date.getUTCMonth() + 12);
  return date.toISOString();
}

/** The reference texts the worker serves: the shared clearance contract's statements and per-state rules at revision 2. */
export function referenceTextsFixture() {
  return {
    revision: TERRITORY_RULES_REVISION,
    statements: { ...TERRITORY_CLEARANCE_STATEMENTS },
    states: Object.values(TERRITORY_STATE_RULES).map((rule) => ({ state: rule.state, name: rule.name, summary: rule.summary,
      citation: { ...rule.citation }, furtherCitations: rule.furtherCitations.map((citation) => ({ ...citation })) })),
  };
}

/**
 * The Settings sections slice S5 added, as the worker serves them: the five templates with one approved, the
 * sending limit with the ceiling fixed in code and today's cap line, S4's research record absent and saying so,
 * the call hours at the code floor, phone setup cleared, a connected grant, and not paused. Every address,
 * mailbox and postal address here is fictional.
 */
export const STUB_POSTAL_ADDRESS = '12 Fictional Way, Suite 3, Providence, RI 02903';
export const STUB_MAILBOX = 'founder@usecallie.invalid';
const SIGN_OFF = 'David Cui\nFounder, Callie\nhttps://usecallie.invalid\n+14015550200';
const STOP_LINE = 'Reply "stop" and I will not email you again.';
export const stubFooterBlock = (postalAddress: string): string => `${SIGN_OFF}\n${postalAddress}\n${STOP_LINE}`;

function templatesFixture(postalAddress: string): NonNullable<SettingsView['templates']> {
  const footer = stubFooterBlock(postalAddress);
  return ['T1', 'T2', 'T3', 'T4', 'T5'].map((templateId, index) => {
    const approved = templateId === 'T4';
    const body = approved ? `Fictional body for ${templateId}.\n\n${footer}` : `Fictional body for ${templateId}.\n\n${SIGN_OFF}`;
    return {
      templateId, name: `Template ${templateId}`, subject: `Fictional subject ${templateId}`, body,
      variables: ['firmName'], revision: index + 1,
      state: approved ? ('approved' as const) : ('draft' as const),
      approvedAt: approved ? instant(60 * 24) : null, approvedRevision: approved ? index + 1 : null,
      approved, footerPresent: approved, issues: approved ? [] : ['template_footer_missing'],
    };
  });
}

function sendingFixture(postalAddress: string): NonNullable<SettingsView['sending']> {
  return {
    dailyLimit: 40, ramp: { startPerDay: 10, stepPerDay: 2, maxPerDay: 40 },
    ceiling: { dailyLimit: 40, startPerDay: 10, stepPerDay: 2, maxPerDay: 40 },
    postalAddress, revision: 2, updatedAt: instant(60 * 24 * 3),
    capLine: { date: '2026-09-18', cap: 12, day: 2, used: 5, remaining: 7 },
    footerBlock: stubFooterBlock(postalAddress),
  };
}

const CALL_FLOOR = { days: [1, 2, 3, 4, 5], window: { startMinute: 480, endMinute: 1200 } };
const callsFixture = (): CallPolicyView => ({ floor: CALL_FLOOR, window: { startMinute: 480, endMinute: 1200 }, byState: [], capPerRun: null, revision: 0, updatedAt: null });
const phoneFixture = (): PhoneSetupView => ({ status: 'cleared', confirmedAt: null, proofDigest: null, confirmedBy: null, revision: 0, updatedAt: null });
const pausedFixture = (): PausedView => ({ paused: false, reason: null, at: null, by: null, revision: 0 });

/** Seven Eastern days ending 2026-09-18, with the counts a real week of records would give. */
function weekFixture(asOf: string): WeekView {
  const dates = ['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
  const perDay = [
    { calls: 0, emailsSent: 0, replies: 0, callbacksPromised: 0, callbacksKept: 0, firmsResearched: 0 },
    { calls: 0, emailsSent: 0, replies: 0, callbacksPromised: 0, callbacksKept: 0, firmsResearched: 0 },
    { calls: 6, emailsSent: 3, replies: 1, callbacksPromised: 1, callbacksKept: 0, firmsResearched: 8 },
    { calls: 9, emailsSent: 4, replies: 0, callbacksPromised: 0, callbacksKept: 1, firmsResearched: 11 },
    { calls: 7, emailsSent: 5, replies: 2, callbacksPromised: 2, callbacksKept: 0, firmsResearched: 9 },
    { calls: 4, emailsSent: 2, replies: 1, callbacksPromised: 0, callbacksKept: 1, firmsResearched: 6 },
    { calls: 2, emailsSent: 0, replies: 0, callbacksPromised: 0, callbacksKept: 0, firmsResearched: 0 },
  ];
  const days = dates.map((date, index) => ({ date, ...perDay[index]! }));
  const total = (field: 'calls' | 'emailsSent' | 'replies' | 'callbacksPromised' | 'callbacksKept' | 'firmsResearched') =>
    days.reduce((sum, day) => sum + day[field], 0);
  return weekViewSchema.parse({
    asOf, from: dates[0], to: dates[dates.length - 1], days,
    calls: { total: total('calls'), byOutcome: [{ outcome: 'answered_interested', count: 3 }, { outcome: 'gatekeeper', count: 6 }, { outcome: 'no_answer', count: 9 }, { outcome: 'voicemail', count: 10 }] },
    emailsSent: total('emailsSent'), replies: total('replies'),
    callbacks: { promised: total('callbacksPromised'), kept: total('callbacksKept') },
    firmsResearched: total('firmsResearched'),
    spend: { micros: 184_000, daysCounted: 5, daysMissing: 2, ledger: { limitMicros: 5_000_000, spentMicros: 612_000, approvedAt: instant(60 * 24 * 40) } },
    holds: [{ reason: 'cap_reached', code: 'cap_reached', count: 4 }, { reason: 'state_not_cleared', code: 'no_posture', count: 2 }],
  });
}

const LANES: readonly TodayLane[] = ['replies', 'callbacks', 'due', 'new'];
/** The card for one firm in a view, whichever lane it stands in, with the lane it was found in. */
function findCard(view: TodayView, firmId: string): { lane: TodayLane; card: TodayCard } | null {
  if (view.list === null) return null;
  for (const lane of LANES) {
    const card = view.list.lanes[lane].find((entry) => entry.firmId === firmId);
    if (card) return { lane, card };
  }
  return null;
}

/** The view with one card replaced, or the firm removed when the card is null. */
function replaceCard(view: TodayView, firmId: string, card: TodayCard | null): TodayView {
  if (view.list === null) return view;
  const lanes = { ...view.list.lanes };
  for (const lane of LANES) {
    if (!lanes[lane].some((entry) => entry.firmId === firmId)) continue;
    lanes[lane] = card === null ? lanes[lane].filter((entry) => entry.firmId !== firmId) : lanes[lane].map((entry) => (entry.firmId === firmId ? card : entry));
  }
  const counts = { replies: lanes.replies.length, callbacks: lanes.callbacks.length, due: lanes.due.length, new: lanes.new.length };
  return todayViewSchema.parse({ ...view, list: { ...view.list, header: { ...view.list.header, counts }, lanes } });
}

/** One Firm view, built from the card the stub is showing so the two can never disagree. */
function firmViewOf(view: TodayView, firmId: string, asOf: string): V1FirmView | null {
  const found = findCard(view, firmId);
  if (!found) return null;
  const { card } = found;
  return v1FirmViewSchema.parse({
    asOf, firmId: card.firmId, name: card.name, website: card.website, city: card.city, state: card.state, timeZone: card.timeZone,
    status: card.lastOutcome ? 'in_sequence' : 'new', localTime: card.localTime, dialAllowed: card.dialAllowed,
    holdReason: card.holdReason, holdCode: card.holdCode,
    routes: card.phone ? [{ routeId: `route-${card.firmId}`, channel: 'phone', value: card.phone.number, verification: card.phone.verification, retired: false, suppressed: false }] : [],
    sequence: card.nextStep.kind === 'call'
      ? { source: 'sequence', state: 'active', startedAt: asOf, currentStepId: `step-${card.nextStep.stepIndex}`, stepIndex: card.nextStep.stepIndex,
        stepCount: card.nextStep.stepCount, nextDueAt: card.nextStep.dueAt, restingUntil: null, entries: 1, heldStepIds: [], lastAdvance: 'continue' }
      : null,
    calls: card.lastOutcome ? [{ at: card.lastOutcome.at, outcome: card.lastOutcome.outcome, note: card.lastOutcome.note, callbackOn: card.pendingCallback?.dueOn ?? null,
      neverCallReason: null, routeId: card.phone ? `route-${card.firmId}` : null, dialAllowed: card.dialAllowed, holdCode: card.holdCode, deviceId: null }] : [],
    callbacks: card.pendingCallback ? [card.pendingCallback] : [],
    suppression: null,
    evidence: { sources: 2, researchedAt: asOf, enteredBy: 'research' },
    holds: card.dialAllowed || card.holdReason === null ? [] : [{ reason: card.holdReason, code: card.holdCode ?? card.holdReason, count: 1 }],
  });
}

const readJson = (request: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let total = 0;
  request.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > 65_536) { reject(new Error('body too large')); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length === 0) { resolve(undefined); return; }
    try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid json')); }
  });
  request.on('error', reject);
});

export async function startStubWorker(): Promise<StubWorker> {
  const codes = new Map<string, string>();
  const paired: PairedDevice[] = [];
  const otherDevices: DiagnosticsDevice[] = [
    { deviceId: randomUUID(), label: 'Old MacBook', createdAt: instant(60 * 24 * 40), lastSeenAt: instant(60 * 24 * 2), revokedAt: null, expiresAt: ninetyDaysAfter(instant(60 * 24 * 40)) },
    { deviceId: randomUUID(), label: 'Loaner', createdAt: instant(60 * 24 * 10), lastSeenAt: null, revokedAt: null, expiresAt: ninetyDaysAfter(instant(60 * 24 * 10)) },
  ];
  const attempts = attemptFixture();
  const asOf = new Date(NOW).toISOString();
  let today: TodayView = todayFixture();
  const postures = new Map<string, StatePostureSummary>();
  // The S5 sections the stub keeps, so a command a spec sends is visible on the next read.
  let calls: CallPolicyView = callsFixture();
  let phone: PhoneSetupView = phoneFixture();
  let paused: PausedView = pausedFixture();
  let sending = sendingFixture(STUB_POSTAL_ADDRESS);
  let templates = templatesFixture(STUB_POSTAL_ADDRESS);
  const requests: StubRequest[] = [];
  const commands: V1Command[] = [];
  const receipts = new Map<string, unknown>();

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };

  const devicesView = (): DiagnosticsDevice[] => [
    ...paired.map((device) => ({
      deviceId: device.deviceId, label: device.label, createdAt: device.createdAt, lastSeenAt: asOf,
      revokedAt: device.revoked ? asOf : null, expiresAt: ninetyDaysAfter(device.createdAt),
    })),
    ...otherDevices,
  ];

  /** The paired device behind the bearer, or the 401 body the worker would send. */
  const authenticate = (authorization: string | undefined): { device: PairedDevice } | { status: 401; body: unknown } => {
    const match = BEARER.exec(authorization ?? '');
    const device = match ? paired.find((candidate) => candidate.token === match[1]) : undefined;
    if (!device) return { status: 401, body: { error: 'unauthenticated' } };
    if (device.revoked) return { status: 401, body: { error: 'unauthenticated', reason: 'device_revoked' } };
    if (device.expired) return { status: 401, body: { error: 'unauthenticated', reason: 'device_expired' } };
    return { device };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    requests.push({ method, path: url.pathname, query: url.searchParams, authenticated: BEARER.test(request.headers.authorization ?? '') });

    if (url.pathname === '/v1/pair/redeem' && method === 'POST') {
      const body = pairRedeemRequestSchema.safeParse(await readJson(request).catch(() => undefined));
      if (!body.success) return send(response, 400, { error: 'invalid_request' });
      if (!PAIR_CODE.test(body.data.code)) return send(response, 400, { error: 'pair_refused', reason: 'code_invalid' });
      const label = codes.get(body.data.code);
      if (label === undefined) return send(response, 400, { error: 'pair_refused', reason: 'code_unknown' });
      codes.delete(body.data.code);
      const device: PairedDevice = { deviceId: randomUUID(), label, token: secret(), createdAt: asOf, expired: false, revoked: false };
      paired.push(device);
      return send(response, 200, pairRedeemResponseSchema.parse({ deviceToken: device.token, deviceId: device.deviceId, workspaceId: 'ws' }));
    }

    if (url.pathname === '/v1/diagnostics' && method === 'GET') {
      const auth = authenticate(request.headers.authorization);
      if ('status' in auth) return send(response, auth.status, auth.body);
      const kind = url.searchParams.get('kind');
      if (kind !== null && !attemptKindSchema.safeParse(kind).success) return send(response, 400, { error: 'invalid_request' });
      const filtered = kind === null ? attempts : attempts.filter((attempt) => attempt.kind === kind);
      return send(response, 200, diagnosticsViewSchema.parse({
        asOf, attempts: filtered.slice(0, DIAGNOSTICS_ATTEMPT_LIMIT),
        lastTick: { at: instant(3), status: 'completed', durationMs: 1830 }, devices: devicesView(),
      }));
    }

    if (url.pathname === '/v1/settings' && method === 'GET') {
      const auth = authenticate(request.headers.authorization);
      if ('status' in auth) return send(response, auth.status, auth.body);
      return send(response, 200, settingsViewSchema.parse({
        postures: [...postures.values()].sort((a, b) => (a.state < b.state ? -1 : 1)), referenceTexts: referenceTextsFixture(),
        templates, sending,
        research: { present: false, readOnlyReason: 'research_config_absent',
          note: 'Research config is not set. This section is read-only until the research slice ships set_research_config.',
          config: null, descriptor: null, ledger: null },
        calls, phone, google: { status: 'connected', email: STUB_MAILBOX, grants: 1, reconsentAtCutover: true,
          note: 'Connected through the pairing-bound grant the old worker holds. It is replaced by a fresh consent at cutover.' },
        devices: devicesView(), paused,
      }));
    }

    if (url.pathname === '/v1/week' && method === 'GET') {
      const auth = authenticate(request.headers.authorization);
      if ('status' in auth) return send(response, auth.status, auth.body);
      return send(response, 200, weekFixture(asOf));
    }

    if (url.pathname === '/v1/today' && method === 'GET') {
      const auth = authenticate(request.headers.authorization);
      if ('status' in auth) return send(response, auth.status, auth.body);
      return send(response, 200, todayViewSchema.parse(today));
    }

    if (url.pathname === '/v1/firms' && method === 'GET') {
      const auth = authenticate(request.headers.authorization);
      if ('status' in auth) return send(response, auth.status, auth.body);
      const firmId = url.searchParams.get('firmId');
      if (firmId === null || firmId.length === 0) return send(response, 400, { error: 'invalid_request' });
      const view = firmViewOf(today, firmId, asOf);
      return view === null ? send(response, 404, { error: 'not_found' }) : send(response, 200, view);
    }

    if (url.pathname === '/v1/commands' && method === 'POST') {
      const auth = authenticate(request.headers.authorization);
      if ('status' in auth) return send(response, auth.status, auth.body);
      const parsed = v1CommandSchema.safeParse(await readJson(request).catch(() => undefined));
      if (!parsed.success) return send(response, 400, { error: 'invalid_request' });
      const command = parsed.data;
      commands.push(command);
      const previous = receipts.get(command.commandId);
      if (previous !== undefined) return send(response, 200, previous);
      let receipt: unknown;
      // set_state_posture is kept, as the worker keeps it: the next /v1/settings read shows the decision with the worker's stamps.
      if (command.kind === 'set_state_posture') {
        postures.set(command.state, { state: command.state, posture: command.posture, decidedAt: asOf, decidedBy: auth.device.label, reviewAt: twelveMonthsAfter(asOf), reviewOverdue: false });
        receipt = { commandId: command.commandId, outcome: 'applied', reason: null };
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      // One dialed call (S2), applied the way the worker applies it to the degree the specs need.
      if (command.kind === 'log_call_outcome') {
        const found = findCard(today, command.firmId);
        if (!found) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'firm_unknown' };
        else {
          const suppressing = command.outcome === 'opt_out' || command.neverCall !== undefined;
          const card: TodayCard | null = suppressing ? null : {
            ...found.card,
            ...(command.outcome === 'callback' && command.callbackOn !== undefined
              ? { lane: 'callbacks' as const, reason: 'callback_due', pendingCallback: { dueOn: command.callbackOn, promisedAt: command.observedAt },
                nextStep: { kind: 'callback' as const, dueOn: command.callbackOn } }
              : { pendingCallback: null }),
            lastOutcome: { outcome: command.outcome, at: command.observedAt, note: command.note ?? null },
          };
          today = replaceCard(today, command.firmId, card);
          receipt = { commandId: command.commandId, outcome: 'applied', reason: null, slice: { kind: 'card', firmId: command.firmId, card } };
        }
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      // A firm entered by hand (S2) is in the pool, not on today's list: the slice names it with no card.
      if (command.kind === 'add_firm') {
        receipt = { commandId: command.commandId, outcome: 'applied', reason: null, slice: { kind: 'card', firmId: `account-hand-${commands.length}`, card: null } };
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      // Approving a template (S3) keeps David's exact text with the footer rule the worker applies: a body that
      // does not end with the footer block the current postal address makes is refused, never quietly approved.
      if (command.kind === 'approve_template') {
        const held = templates.find((template) => template.templateId === command.templateId);
        if (!held) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'template_unknown' };
        else if (held.revision !== command.expectedRevision) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'template_revision_conflict' };
        else if (sending.postalAddress === null) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'postal_address_not_set' };
        else if (!command.body.endsWith(stubFooterBlock(sending.postalAddress))) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'template_footer_missing' };
        else {
          const revision = held.revision + 1;
          templates = templates.map((template) => template.templateId === command.templateId
            ? { ...template, subject: command.subject, body: command.body, revision, state: 'approved' as const,
              approvedAt: asOf, approvedRevision: revision, approved: true, footerPresent: true, issues: [] }
            : template);
          receipt = { commandId: command.commandId, outcome: 'applied', reason: null };
        }
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      // The sending limit (S3) may only narrow the ceiling fixed in code; a request that would widen one is refused whole.
      if (command.kind === 'set_sending_limit') {
        const candidate = { ...sending, ...(command.dailyLimit === undefined ? {} : { dailyLimit: command.dailyLimit }),
          ...(command.ramp === undefined ? {} : { ramp: command.ramp }),
          ...(command.postalAddress === undefined ? {} : { postalAddress: command.postalAddress }) };
        const widened = candidate.dailyLimit > sending.ceiling.dailyLimit || candidate.ramp.startPerDay > sending.ceiling.startPerDay
          || candidate.ramp.stepPerDay > sending.ceiling.stepPerDay || candidate.ramp.maxPerDay > sending.ceiling.maxPerDay;
        if (widened) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'sending_limit_exceeds_code_ceiling' };
        else {
          sending = { ...candidate, revision: sending.revision + 1, updatedAt: asOf,
            capLine: { ...sending.capLine, cap: Math.min(sending.capLine.cap, candidate.dailyLimit),
              remaining: Math.max(0, Math.min(sending.capLine.cap, candidate.dailyLimit) - sending.capLine.used) },
            footerBlock: candidate.postalAddress === null ? null : stubFooterBlock(candidate.postalAddress) };
          receipt = { commandId: command.commandId, outcome: 'applied', reason: null };
        }
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      // The Settings commands (S5). Each one is kept and each one answers with the section it changed, which is
      // what the page reads; the narrowing rule is the worker's, and the stub refuses a window outside the floor
      // exactly as the worker does rather than accepting hours the real core never would.
      if (command.kind === 'set_call_policy') {
        const proposed = [...(command.window ? [command.window] : []), ...(command.byState ?? []).map((entry) => entry.window)];
        const outside = proposed.some((window) => window.startMinute < CALL_FLOOR.window.startMinute || window.endMinute > CALL_FLOOR.window.endMinute);
        if (outside) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'call_policy_outside_floor' };
        else {
          calls = { ...calls, ...(command.window ? { window: command.window } : {}), ...(command.byState ? { byState: command.byState } : {}),
            ...(command.capPerRun === undefined ? {} : { capPerRun: command.capPerRun }), revision: calls.revision + 1, updatedAt: asOf };
          receipt = { commandId: command.commandId, outcome: 'applied', reason: null, slice: { kind: 'call_policy', calls } };
        }
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      if (command.kind === 'confirm_phone_setup' || command.kind === 'clear_phone_setup') {
        const confirmed = command.kind === 'confirm_phone_setup';
        phone = { status: confirmed ? 'confirmed' : 'cleared', confirmedAt: confirmed ? asOf : null,
          proofDigest: confirmed ? command.proofDigest : null, confirmedBy: confirmed ? auth.device.label : null,
          revision: phone.revision + 1, updatedAt: asOf };
        receipt = { commandId: command.commandId, outcome: 'applied', reason: null, slice: { kind: 'phone_setup', phone } };
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      if (command.kind === 'pause' || command.kind === 'resume') {
        const stopped = command.kind === 'pause';
        paused = { paused: stopped, reason: stopped ? command.reason : null, at: asOf, by: auth.device.label, revision: paused.revision + 1 };
        receipt = { commandId: command.commandId, outcome: 'applied', reason: null, slice: { kind: 'paused', paused } };
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      // `admit_route` and `suppress` (S2) are applied without being kept: no spec reads them back off the stub.
      if (command.kind === 'admit_route' || command.kind === 'suppress') {
        receipt = { commandId: command.commandId, outcome: 'applied', reason: null };
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      // Anything else the contract carries that no client page sends yet is refused honestly, never answered as applied.
      if (command.kind !== 'revoke_device') {
        receipt = { commandId: command.commandId, outcome: 'refused', reason: 'command_not_stubbed' };
        receipts.set(command.commandId, receipt);
        return send(response, 200, v1CommandReceiptSchema.parse(receipt));
      }
      const target = otherDevices.find((device) => device.deviceId === command.deviceId);
      if (target === undefined) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'device_unknown' };
      else if (target.revokedAt !== null) receipt = { commandId: command.commandId, outcome: 'refused', reason: 'device_revoked' };
      else { target.revokedAt = asOf; receipt = { commandId: command.commandId, outcome: 'applied', reason: null }; }
      receipts.set(command.commandId, receipt);
      return send(response, 200, v1CommandReceiptSchema.parse(receipt));
    }

    return send(response, 404, { error: 'not_found' });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => send(response, 500, { error: 'worker_error' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    asOf,
    get today() { return today; },
    firmView: (firmId) => firmViewOf(today, firmId, asOf),
    setToday: (view) => { today = todayViewSchema.parse(view); },
    postures: () => [...postures.values()].sort((a, b) => (a.state < b.state ? -1 : 1)),
    requests,
    commands,
    mintCode: (label) => { const code = secret(); codes.set(code, label); return code; },
    unknownCode: () => secret(),
    writeCodeFile: async (label, directory) => {
      const path = join(directory, `device-code-${randomUUID()}`);
      const code = secret();
      codes.set(code, label);
      await writeFile(path, `${code}\n`, { mode: 0o600 });
      return path;
    },
    attempts: (kind) => (kind === undefined ? attempts : attempts.filter((attempt) => attempt.kind === kind)),
    pairedDevices: () => paired.map((device) => ({ ...device })),
    otherDevices: () => otherDevices.map((device) => ({ ...device })),
    expireDevice: (deviceId) => { const device = paired.find((candidate) => candidate.deviceId === deviceId); if (device) device.expired = true; },
    revokeDevice: (deviceId) => { const device = paired.find((candidate) => candidate.deviceId === deviceId); if (device) device.revoked = true; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => (error ? reject(error) : resolve())); }),
  };
}
