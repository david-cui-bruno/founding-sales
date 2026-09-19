import { describe, expect, it } from 'vitest';
import { attemptRecordSchema } from '../../../../../src/shared/contracts/v1Contract';
import { DynamoStore } from '../../src/dynamoStore';
import { ATTEMPT_PREFIX, ATTEMPT_TTL_SECONDS, listAttempts, recordAttempt, sanitiseAttemptDetail } from '../../src/v1/attempts';
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
