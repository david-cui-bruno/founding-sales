import { randomUUID } from 'node:crypto';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { attemptDetailSchema, attemptRecordSchema } from '../../../../../src/shared/contracts/v1Contract';
import { DynamoStore, fingerprint, type DynamoAdapter } from '../../src/dynamoStore';
import { createWorkerHandler } from '../../src/handler';
import { RemoteGoogleAuthorization } from '../../src/remoteGoogleAuthorization';
import { createSourceCoordinator } from '../../src/sourceCoordinator';
import { tickPhases } from '../../src/tickLog';
import { ATTEMPT_PREFIX, ATTEMPT_TTL_SECONDS, attemptCode, listAttempts, recordAttempt } from '../../src/v1/attempts';
import { WorkerAuth } from '../../src/workerAuth';
import { ConditionalCommandHarness } from '../sdkHarness';

/**
 * The attempt log on the real store and the in-memory Dynamo harness. Nothing here touches AWS, a
 * provider, a mailbox or a phone; the log is the worker's own account of what it tried. A detail is
 * never free text: it is the closed object of the contract or null.
 */
function storeFixture(start = '2026-09-18T12:00:00.000Z') {
  const db = new ConditionalCommandHarness(); let now = start;
  const store = new DynamoStore({ dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } });
  return { db, store, advance: (value: string) => { now = value; } };
}
const base = { at: '2026-09-18T12:00:00.000Z', kind: 'send', outcome: 'ok', reason: null, durationMs: null, ref: null } as const;

describe('the attempt log', () => {
  it('stores every attempt under ATTEMPT#<at>#<8 hex> with a 30 day ttl, lists newest first, honours limit and the kind filter', async () => {
    const f = storeFixture();
    const times = ['2026-09-18T12:00:00.000Z', '2026-09-18T12:05:00.000Z', '2026-09-18T12:10:00.000Z', '2026-09-18T12:15:00.000Z', '2026-09-18T12:20:00.000Z', '2026-09-18T12:25:00.000Z', '2026-09-18T12:30:00.000Z'];
    for (const [index, at] of times.entries()) {
      f.advance(at);
      await recordAttempt(f.store, { kind: index % 2 === 0 ? 'tick' : 'tick_phase', outcome: 'ok', reason: null, detail: { code: 'sample', count: index }, durationMs: index, ref: `ref-${index}` });
    }
    const keys = f.db.dump().map(item => item.sk!.S!).filter(sk => sk.startsWith(ATTEMPT_PREFIX)).sort();
    expect(keys).toHaveLength(7);
    for (const [index, key] of keys.entries()) expect(key).toMatch(new RegExp(`^ATTEMPT#${times[index]}#[0-9a-f]{8}$`));
    const stored = f.db.dump().find(item => item.sk!.S!.startsWith(ATTEMPT_PREFIX))!;
    expect(Number(stored.ttl!.N)).toBe(Math.floor(Date.parse(times[0]!) / 1000) + ATTEMPT_TTL_SECONDS);
    expect(ATTEMPT_TTL_SECONDS).toBe(30 * 24 * 3600);
    const all = await listAttempts(f.store, {});
    expect(all.map(attempt => attempt.detail?.count)).toEqual([6, 5, 4, 3, 2, 1, 0]);
    for (const attempt of all) expect(attemptRecordSchema.safeParse(attempt).success).toBe(true);
    expect((await listAttempts(f.store, { limit: 5 })).map(attempt => attempt.detail?.count)).toEqual([6, 5, 4, 3, 2]);
    expect((await listAttempts(f.store, { kind: 'tick_phase' })).map(attempt => attempt.detail?.count)).toEqual([5, 3, 1]);
    expect((await listAttempts(f.store, { kind: 'tick_phase', limit: 2 })).map(attempt => attempt.detail?.count)).toEqual([5, 3]);
    // The limit is capped at the contract's 20 whatever the caller asks for.
    for (let index = 0; index < 20; index++) { f.advance(`2026-09-18T13:${String(index).padStart(2, '0')}:00.000Z`); await recordAttempt(f.store, { kind: 'poll', outcome: 'ok', reason: null, detail: null, durationMs: null, ref: null }); }
    expect(await listAttempts(f.store, { limit: 50 })).toHaveLength(20);
  });

  it('a detail is the closed object or null: the schema refuses free text, an unknown key, a non-slug code and an over-long cursor', () => {
    const full = { code: 'provider_error', firmId: 'f'.repeat(80), jobId: 'j'.repeat(80), commandId: randomUUID(), providerStatus: 429, providerCode: 'rate_limited', count: 3, bytes: 1200, cursor: 'a'.repeat(12) };
    expect(attemptDetailSchema.safeParse(full).success).toBe(true);
    expect(attemptRecordSchema.safeParse({ ...base, detail: full }).success).toBe(true);
    expect(attemptRecordSchema.safeParse({ ...base, detail: null }).success).toBe(true);
    expect(attemptRecordSchema.safeParse({ ...base, detail: { code: 'sent' } }).success).toBe(true);
    for (const detail of [
      'Google refused mail to owner@fictional-firm.example', '', 'sent',
      { code: 'sent', extra: 1 }, { code: 'sent', message: 'free text' }, { code: 'sent', firmId: 'f'.repeat(81) },
      { code: 'Not A Slug' }, { code: 'x'.repeat(41) }, {}, { count: 1 },
      { code: 'sent', cursor: 'c'.repeat(13) }, { code: 'sent', providerCode: 'Rate-Limited' }, { code: 'sent', count: 1.5 }, { code: 'sent', bytes: -1 },
    ]) expect({ detail, refused: !attemptRecordSchema.safeParse({ ...base, detail }).success }).toEqual({ detail, refused: true });
  });

  it('turns command kinds and error classes into codes', () => {
    expect(attemptCode('bootstrap-selected-account')).toBe('bootstrap_selected_account');
    expect(attemptCode('refresh-selected-account-record')).toBe('refresh_selected_account_record');
    expect(attemptCode('revoke_device')).toBe('revoke_device');
    expect(attemptCode('DynamoReadUnavailable')).toBe('dynamo_read_unavailable');
    expect(attemptCode('ZodError')).toBe('zod_error');
    expect(attemptCode('DOMException')).toBe('dom_exception');
    expect(attemptCode('unknown')).toBe('unknown');
    expect(attemptCode('  Weird  value!! ')).toBe('weird_value');
    expect(attemptCode('x'.repeat(60))).toHaveLength(40);
    for (const value of ['bootstrap-selected-account', 'DOMException', '  Weird  value!! ', 'x'.repeat(60)]) expect(attemptDetailSchema.safeParse({ code: attemptCode(value) }).success).toBe(true);
  });

  it('never throws into the caller and never logs a record: a refused record or a failed write is one warning carrying only the event and the kind', async () => {
    const f = storeFixture();
    const warnings: string[] = []; const warn = console.warn; console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      // A string detail is refused by the contract, so the record is dropped, not sanitised.
      await recordAttempt(f.store, { kind: 'send', outcome: 'failed', reason: 'provider_error', durationMs: 12, ref: 'acct', detail: 'Google refused mail to owner@fictional-firm.example' as unknown as null });
      await recordAttempt(f.store, { kind: 'send', outcome: 'ok', reason: 'Not A Slug!', detail: null, durationMs: null, ref: null });
      const broken = new DynamoStore({ dynamo: { send: async () => { throw new Error('secret-provider-detail https://private.invalid'); } }, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => '2026-09-18T12:00:00.000Z' } });
      await expect(recordAttempt(broken, { kind: 'tick', outcome: 'ok', reason: null, detail: { code: 'completed', count: 0 }, durationMs: 1, ref: null })).resolves.toBeUndefined();
      await recordAttempt(f.store, { kind: 'send', outcome: 'ok', reason: null, detail: { code: 'provider_accepted', firmId: 'acct' }, durationMs: null, ref: 'acct' });
    } finally { console.warn = warn; }
    expect(warnings).toHaveLength(3);
    for (const line of warnings) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(['event', 'kind']);
      expect(['attempt_record_invalid', 'attempt_record_write_failed']).toContain(parsed.event);
    }
    const text = warnings.join('\n');
    expect(text).not.toContain('owner@'); expect(text).not.toContain('private.invalid'); expect(text).not.toContain('Not A Slug'); expect(text).not.toContain('completed');
    expect(await listAttempts(f.store, {})).toEqual([expect.objectContaining({ detail: { code: 'provider_accepted', firmId: 'acct' } })]);
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
  it('one tick writes one tick attempt and one tick_phase attempt per phase, each with its outcome and a closed detail', async () => {
    const f = tickFixture();
    const log = console.log; const lines: string[] = []; console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    let report;
    try { report = await f.tick(); } finally { console.log = log; }
    expect(report.status).toBe('inactive');
    // The tick writes its attempts to the store and nothing about them to the console.
    expect(lines.filter(line => line.includes('ATTEMPT') || line.includes('"kind":"tick'))).toEqual([]);
    const ticks = await listAttempts(f.auth.store, { kind: 'tick' });
    expect(ticks).toEqual([expect.objectContaining({ outcome: 'ok', reason: null, durationMs: expect.any(Number), ref: null, detail: { code: 'inactive', count: 0 } })]);
    const phases = await listAttempts(f.auth.store, { kind: 'tick_phase' });
    expect(phases).toHaveLength(tickPhases.length);
    expect(phases.map(phase => phase.ref).sort()).toEqual([...tickPhases].sort());
    for (const phase of phases) expect(phase).toMatchObject({ outcome: 'ok', reason: null, detail: null, durationMs: expect.any(Number) });
    // 12:00Z is 08:00 Eastern: the first tick at or after 05:00 also builds the morning list (S1), once, and records it as a `list` attempt.
    // With no firms the list is empty; the LIST_BUILT line carries counts only.
    expect(await listAttempts(f.auth.store, { kind: 'list' })).toEqual([expect.objectContaining({ outcome: 'ok', reason: null, ref: 'day:2026-09-18',
      detail: { code: 'list_built', count: 0, lanes: { replies: 0, callbacks: 0, due: 0, new: 0 } } })]);
    expect(lines.filter(line => line.includes('LIST_BUILT'))).toHaveLength(1);
    expect(await listAttempts(f.auth.store, {})).toHaveLength(tickPhases.length + 2);
  });

  it('a phase that fails is a held tick_phase attempt with the phase failure as its reason, and the tick attempt is held for the same reason', async () => {
    // The configurations phase starts by reading its scan cursor; refusing that one read fails exactly that phase.
    const f = tickFixture(sk => sk === `SOURCE_SCAN#${fingerprint('OWNER_SOURCE#')}`);
    const report = await f.tick();
    expect(report.phases.configurations).toBe('held');
    expect(report.heldByReason).toEqual({ configurations_phase_failed: 1 });
    const phases = await listAttempts(f.auth.store, { kind: 'tick_phase' });
    expect(phases.find(phase => phase.ref === 'configurations')).toMatchObject({ outcome: 'held', reason: 'configurations_phase_failed', detail: null });
    expect(phases.filter(phase => phase.outcome === 'ok')).toHaveLength(tickPhases.length - 1);
    const [tick] = await listAttempts(f.auth.store, { kind: 'tick' });
    expect(tick).toMatchObject({ outcome: 'held', reason: 'configurations_phase_failed', detail: { code: 'inactive', count: 1 } });
    expect(JSON.stringify(f.harness.dump())).not.toContain('private.invalid');
  });

  it('one /commands request and one /events page each write one attempt on the real handler, refusals included, with structured detail', async () => {
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
    expect(await listAttempts(auth.store, { kind: 'command' })).toEqual([{ at: now, kind: 'command', outcome: 'ok', reason: null, detail: { code: 'bootstrap_selected_account', commandId }, durationMs: null, ref: commandId }]);
    // A refused command (the same bootstrap again, at a version that has moved on) is recorded under the closed code the
    // handler answered with and its command id; no exception text enters the record.
    const slug = /^[a-z0-9]+(?:_[a-z0-9]+)*$/; const staleId = randomUUID();
    const stale = await handle(event('POST', '/commands', { ...command, commandId: staleId }));
    expect(stale.statusCode).toBe(400);
    // Same fixed instant as the applied attempt, so it is found by its ref, not by its position in the page.
    const refused = (await listAttempts(auth.store, { kind: 'command' })).find(attempt => attempt.ref === staleId)!;
    expect(refused).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(slug), ref: staleId, detail: { code: expect.stringMatching(slug), commandId: staleId } });
    expect(refused.detail!.code).toBe(refused.reason);

    const page = await handle(event('GET', '/events'));
    expect(page.statusCode).toBe(200);
    const events = JSON.parse(page.body) as { events: unknown[] };
    const [pageAttempt] = await listAttempts(auth.store, { kind: 'events_page' });
    expect(pageAttempt).toMatchObject({ outcome: 'ok', reason: null, ref: null, detail: { code: 'events_page', cursor: 'none', count: events.events.length, bytes: Buffer.byteLength(page.body, 'utf8') } });
    expect(events.events.length).toBeGreaterThan(0);

    // A refused request is recorded too, under the closed code the handler answered with, never the exception.
    expect((await handle(event('GET', '/events', undefined, bearer, 'cursor=not-a-cursor'))).statusCode).toBe(400);
    expect((await handle(event('POST', '/commands', command, `Bearer ${'x'.repeat(43)}`))).statusCode).toBe(401);
    const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
    expect(sorted((await listAttempts(auth.store, { kind: 'events_page' })).map(attempt => [attempt.outcome, attempt.reason, attempt.detail]))).toEqual(sorted([
      ['ok', null, pageAttempt!.detail], ['failed', 'invalid_cursor', { code: 'invalid_cursor', cursor: 'not-a-cursor' }]]));
    const commandAttempts = (await listAttempts(auth.store, { kind: 'command' })).map(attempt => [attempt.outcome, attempt.reason]);
    expect(commandAttempts).toHaveLength(3);
    expect(commandAttempts).toContainEqual(['ok', null]);
    expect(commandAttempts).toContainEqual(['failed', 'worker_unauthorized']);
    expect(commandAttempts.filter(([outcome]) => outcome === 'failed')).toHaveLength(2);
    expect(await listAttempts(auth.store, {})).toHaveLength(5);
    expect(JSON.stringify(harness.dump())).not.toContain(pairing.credential);
  });
});
