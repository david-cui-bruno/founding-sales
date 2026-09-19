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
  type AttemptRecord,
  type DiagnosticsDevice,
  type StatePostureSummary,
  type TodayCard,
  type TodayView,
  type V1Command,
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
      return send(response, 200, settingsViewSchema.parse({ postures: [...postures.values()].sort((a, b) => (a.state < b.state ? -1 : 1)), referenceTexts: referenceTextsFixture() }));
    }

    if (url.pathname === '/v1/today' && method === 'GET') {
      const auth = authenticate(request.headers.authorization);
      if ('status' in auth) return send(response, auth.status, auth.body);
      return send(response, 200, todayViewSchema.parse(today));
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
      // The stub models the two commands the client pages issue. Anything else the contract now carries (the S3
      // email commands, which no client page sends yet) is refused honestly rather than answered as applied.
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
