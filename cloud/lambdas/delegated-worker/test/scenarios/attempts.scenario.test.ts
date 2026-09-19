import { randomUUID } from 'node:crypto';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { attemptRecordSchema } from '../../../../../src/shared/contracts/v1Contract';
import { DynamoStore, fingerprint, type DynamoAdapter } from '../../src/dynamoStore';
import { createWorkerHandler } from '../../src/handler';
import { RemoteGoogleAuthorization } from '../../src/remoteGoogleAuthorization';
import { createSourceCoordinator } from '../../src/sourceCoordinator';
import { tickPhases } from '../../src/tickLog';
import { ATTEMPT_PREFIX, ATTEMPT_TTL_SECONDS, listAttempts, recordAttempt, sanitiseAttemptDetail } from '../../src/v1/attempts';
import { WorkerAuth } from '../../src/workerAuth';
import { ConditionalCommandHarness } from '../sdkHarness';

/**
 * The attempt log on the real store and the in-memory Dynamo harness. Nothing here touches AWS, a
 * provider, a mailbox or a phone; the log is the worker's own account of what it tried.
 */
function storeFixture(start = '2026-09-18T12:00:00.000Z') {
  const db = new ConditionalCommandHarness(); let now = start;
  const store = new DynamoStore({ dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } });
  return { db, store, advance: (value: string) => { now = value; } };
}

describe('the attempt log', () => {
  it('stores every attempt under ATTEMPT#<at>#<8 hex> with a 30 day ttl, lists newest first, honours limit and the kind filter', async () => {
    const f = storeFixture();
    const times = ['2026-09-18T12:00:00.000Z', '2026-09-18T12:05:00.000Z', '2026-09-18T12:10:00.000Z', '2026-09-18T12:15:00.000Z', '2026-09-18T12:20:00.000Z', '2026-09-18T12:25:00.000Z', '2026-09-18T12:30:00.000Z'];
    for (const [index, at] of times.entries()) {
      f.advance(at);
      await recordAttempt(f.store, { kind: index % 2 === 0 ? 'tick' : 'tick_phase', outcome: 'ok', reason: null, detail: `attempt ${index}`, durationMs: index, ref: `ref-${index}` });
    }
    const keys = f.db.dump().map(item => item.sk!.S!).filter(sk => sk.startsWith(ATTEMPT_PREFIX)).sort();
    expect(keys).toHaveLength(7);
    for (const [index, key] of keys.entries()) expect(key).toMatch(new RegExp(`^ATTEMPT#${times[index]}#[0-9a-f]{8}$`));
    const stored = f.db.dump().find(item => item.sk!.S!.startsWith(ATTEMPT_PREFIX))!;
    expect(Number(stored.ttl!.N)).toBe(Math.floor(Date.parse(times[0]!) / 1000) + ATTEMPT_TTL_SECONDS);
    expect(ATTEMPT_TTL_SECONDS).toBe(30 * 24 * 3600);
    const all = await listAttempts(f.store, {});
    expect(all.map(attempt => attempt.detail)).toEqual(['attempt 6', 'attempt 5', 'attempt 4', 'attempt 3', 'attempt 2', 'attempt 1', 'attempt 0']);
    for (const attempt of all) expect(attemptRecordSchema.safeParse(attempt).success).toBe(true);
    expect((await listAttempts(f.store, { limit: 5 })).map(attempt => attempt.detail)).toEqual(['attempt 6', 'attempt 5', 'attempt 4', 'attempt 3', 'attempt 2']);
    expect((await listAttempts(f.store, { kind: 'tick_phase' })).map(attempt => attempt.detail)).toEqual(['attempt 5', 'attempt 3', 'attempt 1']);
    expect((await listAttempts(f.store, { kind: 'tick_phase', limit: 2 })).map(attempt => attempt.detail)).toEqual(['attempt 5', 'attempt 3']);
    // The limit is capped at the contract's 20 whatever the caller asks for.
    for (let index = 0; index < 20; index++) { f.advance(`2026-09-18T13:${String(index).padStart(2, '0')}:00.000Z`); await recordAttempt(f.store, { kind: 'poll', outcome: 'ok', reason: null, detail: null, durationMs: null, ref: null }); }
    expect(await listAttempts(f.store, { limit: 50 })).toHaveLength(20);
  });

  it('stores a detail containing an email address, a bearer token and a long base64url run redacted, and never throws into the caller', async () => {
    const f = storeFixture();
    // 51 base64url characters, the shape of a real bearer value, derived here so no token-like literal sits in the source.
    const pasted = Buffer.from('foobarbazquxquuxcorgegraultgarplywaldo').toString('base64url');
    await recordAttempt(f.store, { kind: 'send', outcome: 'failed', reason: 'provider_error', durationMs: 12, ref: 'acct',
      detail: `Google refused mail to owner@fictional-firm.example with Authorization: Bearer ${pasted}; secret ${'a'.repeat(32)} and raw Bearer alone` });
    const [stored] = await listAttempts(f.store, {});
    expect(stored!.detail).not.toContain('owner@'); expect(stored!.detail).not.toContain(pasted); expect(stored!.detail).not.toContain('a'.repeat(32));
    expect(stored!.detail).not.toMatch(/Bearer/);
    expect(stored!.detail).toContain('[redacted]');
    expect(JSON.stringify(f.db.dump())).not.toContain(pasted);
    // Sanitising is a pure function the router and the coordinators share.
    expect(sanitiseAttemptDetail('cursor=abcdef012345 count=3 bytes=1200')).toBe('cursor=abcdef012345 count=3 bytes=1200');
    expect(sanitiseAttemptDetail('x'.repeat(500))!.length).toBeLessThanOrEqual(400);
    expect(sanitiseAttemptDetail(null)).toBeNull();
    // A record the contract refuses is dropped with a warning, never thrown; a failing write is the same.
    const warnings: unknown[] = []; const warn = console.warn; console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await recordAttempt(f.store, { kind: 'send', outcome: 'ok', reason: 'Not A Slug!', detail: null, durationMs: null, ref: null });
      const broken = new DynamoStore({ dynamo: { send: async () => { throw new Error('secret-provider-detail https://private.invalid'); } }, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => '2026-09-18T12:00:00.000Z' } });
      await expect(recordAttempt(broken, { kind: 'tick', outcome: 'ok', reason: null, detail: null, durationMs: 1, ref: null })).resolves.toBeUndefined();
    } finally { console.warn = warn; }
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings)).not.toContain('private.invalid');
    expect(await listAttempts(f.store, {})).toHaveLength(1);
  });
});

/** The existing scheduled tick on the existing harness: no configuration, no providers, every HTTP boundary refused. */
function tickFixture(failingRead?: (sk: string) => boolean) {
  const harness = new ConditionalCommandHarness();
  const dynamo: DynamoAdapter = { send: async command => {
    if (failingRead && command instanceof GetItemCommand && failingRead(command.input.Key?.sk?.S ?? '')) throw new Error('fictional read outage https://private.invalid');
    return harness.send(command);
  } };
  const options = { dynamo, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => '2026-09-18T12:00:00.000Z' } };
  const auth = new WorkerAuth(options);
  const fetch: typeof globalThis.fetch = async () => { throw new Error('unconfigured fictional HTTP'); };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch });
  return { harness, auth, tick: () => createSourceCoordinator({ auth, authorization, fetch }).tick(new AbortController().signal) };
}

describe('the existing worker records what it does', () => {
  it('one tick writes one tick attempt and one tick_phase attempt per phase, each with its outcome', async () => {
    const f = tickFixture();
    const report = await f.tick();
    expect(report.status).toBe('inactive');
    const ticks = await listAttempts(f.auth.store, { kind: 'tick' });
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ outcome: 'ok', reason: null, durationMs: expect.any(Number), ref: null });
    expect(ticks[0]!.detail).toMatch(/^status=inactive held=0 /);
    const phases = await listAttempts(f.auth.store, { kind: 'tick_phase' });
    expect(phases).toHaveLength(tickPhases.length);
    expect(phases.map(phase => phase.ref).sort()).toEqual([...tickPhases].sort());
    for (const phase of phases) expect(phase).toMatchObject({ outcome: 'ok', reason: null, detail: null, durationMs: expect.any(Number) });
    expect(await listAttempts(f.auth.store, {})).toHaveLength(tickPhases.length + 1);
  });

  it('a phase that fails is a held tick_phase attempt with the phase failure as its reason, and the tick attempt is held for the same reason', async () => {
    // The configurations phase starts by reading its scan cursor; refusing that one read fails exactly that phase.
    const f = tickFixture(sk => sk === `SOURCE_SCAN#${fingerprint('OWNER_SOURCE#')}`);
    const report = await f.tick();
    expect(report.phases.configurations).toBe('held');
    expect(report.heldByReason).toEqual({ configurations_phase_failed: 1 });
    const phases = await listAttempts(f.auth.store, { kind: 'tick_phase' });
    expect(phases.find(phase => phase.ref === 'configurations')).toMatchObject({ outcome: 'held', reason: 'configurations_phase_failed' });
    expect(phases.filter(phase => phase.outcome === 'ok')).toHaveLength(tickPhases.length - 1);
    const [tick] = await listAttempts(f.auth.store, { kind: 'tick' });
    expect(tick).toMatchObject({ outcome: 'held', reason: 'configurations_phase_failed' });
    expect(tick!.detail).toMatch(/^status=inactive held=1 /);
    expect(JSON.stringify(f.harness.dump())).not.toContain('private.invalid');
  });

  it('one /commands request and one /events page each write one attempt on the real handler, refusals included', async () => {
    const host = 'worker.example.test'; const now = '2026-09-18T12:00:00.000Z';
    const harness = new ConditionalCommandHarness();
    const auth = new WorkerAuth({ dynamo: harness, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } });
    const pairing = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, randomUUID());
    const bearer = `Bearer ${pairing.credential}`;
    const handle = createWorkerHandler({ auth, host });
    const event = (method: 'GET' | 'POST', path: string, body?: unknown, authorization = bearer, rawQueryString = '') => ({ version: '2.0', rawPath: path, rawQueryString,
      headers: { host, 'x-forwarded-proto': 'https', authorization }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), isBase64Encoded: false,
      requestContext: { domainName: host, http: { method, sourceIp: 'fictional-device' } } });
    const accountId = 'fictional-firm'; const commandId = randomUUID();
    const account = { id: accountId, name: 'Fictional Property Management', domain: null, version: 1 };
    const command = { commandId, workspaceId: 'ws', accountId, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'bootstrap-selected-account',
      payload: { record: { account, sources: [], routes: [], claims: [], researchRevision: 1, history: [{ at: now, account, claims: [], routes: [] }] }, asOf: now, expectedResearchRevision: null, suppression: [] } };
    const applied = await handle(event('POST', '/commands', command));
    expect(applied.statusCode).toBe(200); expect(JSON.parse(applied.body)).toMatchObject({ status: 'applied' });
    expect(await listAttempts(auth.store, { kind: 'command' })).toEqual([{ at: now, kind: 'command', outcome: 'ok', reason: null, detail: 'kind=bootstrap-selected-account', durationMs: null, ref: commandId }]);

    const page = await handle(event('GET', '/events'));
    expect(page.statusCode).toBe(200);
    const events = JSON.parse(page.body) as { events: unknown[] };
    const [pageAttempt] = await listAttempts(auth.store, { kind: 'events_page' });
    expect(pageAttempt).toMatchObject({ outcome: 'ok', reason: null, ref: null });
    expect(pageAttempt!.detail).toBe(`cursor=none count=${events.events.length} bytes=${Buffer.byteLength(page.body, 'utf8')}`);
    expect(events.events.length).toBeGreaterThan(0);

    // A refused request is recorded too, under the closed code the handler answered with, never the exception.
    expect((await handle(event('GET', '/events', undefined, bearer, 'cursor=not-a-cursor'))).statusCode).toBe(400);
    expect((await handle(event('POST', '/commands', command, `Bearer ${'x'.repeat(43)}`))).statusCode).toBe(401);
    const sorted = (rows: (string | null)[][]) => rows.map(row => row.join(':')).sort();
    expect(sorted((await listAttempts(auth.store, { kind: 'events_page' })).map(attempt => [attempt.outcome, attempt.reason, attempt.detail]))).toEqual(sorted([
      ['ok', null, pageAttempt!.detail], ['failed', 'invalid_cursor', 'cursor=not-a-cursor']]));
    expect(sorted((await listAttempts(auth.store, { kind: 'command' })).map(attempt => [attempt.outcome, attempt.reason]))).toEqual(sorted([['ok', null], ['failed', 'worker_unauthorized']]));
    // Nothing on the old routes is recorded twice, and /emergency is not a /commands attempt.
    expect(await listAttempts(auth.store, {})).toHaveLength(4);
    expect(JSON.stringify(harness.dump())).not.toContain(pairing.credential);
  });
});
