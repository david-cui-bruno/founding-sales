import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../../../../tests/fixtures/pmAccounts';
import { readSuppression } from './suppressionReadModel';
import { AccountNeverCallRepository } from '../callbacks/accountNeverCall';

let fixture: Awaited<ReturnType<typeof createPmFixture>>;
beforeEach(async () => { fixture = await createPmFixture(); });
afterEach(() => { fixture.close(); });

const clock = { now: () => PM_NOW };

it('lists every kind of suppression with when and why, read-only and with no undo', () => {
  const raw = fixture.db.raw;
  const account = fixture.repo.create({ commandId: randomUUID(), name: 'Fictional suppressed PM', domain: null });
  const other = fixture.repo.create({ commandId: randomUUID(), name: 'Fictional replied PM', domain: null });
  // A never-call tombstone, written by the same code path the Today card uses.
  new AccountNeverCallRepository({ database: fixture.db, clock }).suppress({ commandId: '11111111-1111-4111-8111-111111111111', accountId: account.id, reason: 'They told me on the phone never to call again.' });
  // An opt-out observed in a reply, with its handle tombstone.
  raw.prepare('INSERT INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)')
    .run('reply-tombstone', other.id, '2026-09-10T09:00:00.000Z', 'gmail_reply', 'thread-1:incoming-9', PM_NOW);
  raw.prepare('INSERT INTO pm_handle_suppression_tombstones VALUES(?,?,?,?,?,?,?)')
    .run('reply-tombstone:manager@example.test', 'email', 'manager@example.test', '2026-09-10T09:00:00.000Z', 'gmail_reply', 'thread-1:incoming-9', PM_NOW);

  const list = readSuppression({ database: fixture.db, clock });
  expect(list.truncated).toBe(false);
  expect(list.generatedAt).toBe(PM_NOW);
  const kinds = list.entries.map(entry => entry.kind);
  expect(kinds).toContain('never_call');
  expect(kinds).toContain('account_opt_out');
  expect(kinds).toContain('handle_opt_out');
  const neverCall = list.entries.find(entry => entry.kind === 'never_call')!;
  expect(neverCall.accountId).toBe(account.id);
  expect(neverCall.subject).toBe('Fictional suppressed PM');
  expect(neverCall.observedAt).toBe(PM_NOW);
  expect(neverCall.why).toContain('Never call');
  const optOut = list.entries.find(entry => entry.kind === 'account_opt_out')!;
  expect(optOut.accountId).toBe(other.id);
  expect(optOut.observedAt).toBe('2026-09-10T09:00:00.000Z');
  expect(optOut.evidenceRef).toBe('thread-1:incoming-9');
  const handle = list.entries.find(entry => entry.kind === 'handle_opt_out')!;
  expect(handle.subject).toBe('manager@example.test');
  expect(handle.accountId).toBeNull();
  // Newest first, so the most recent suppression explains today's holds without scrolling.
  expect(list.entries.map(entry => entry.observedAt)).toEqual([...list.entries.map(entry => entry.observedAt)].sort().reverse());
  expect(kinds.at(-1)).toBe('never_call');
  // The read writes nothing.
  expect(raw.prepare('SELECT count(*) AS n FROM pm_account_suppression_tombstones').get()).toEqual({ n: 2 });
});

it('names a retired route as suppressed and keeps the current version out of the list', () => {
  const raw = fixture.db.raw;
  const account = fixture.repo.create({ commandId: randomUUID(), name: 'Fictional rerouted PM', domain: null });
  raw.prepare('INSERT INTO pm_account_routes(id,account_id,version,person_id,channel,value,purpose,verification,admitted_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('route-1', account.id, 1, null, 'phone', '+14015550200', 'business', 'published', '2026-09-01T09:00:00.000Z');
  raw.prepare('INSERT INTO pm_account_routes(id,account_id,version,person_id,channel,value,purpose,verification,admitted_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('route-1', account.id, 2, null, 'phone', '+14015550201', 'business', 'published', '2026-09-12T09:00:00.000Z');
  const list = readSuppression({ database: fixture.db, clock });
  const retired = list.entries.filter(entry => entry.kind === 'retired_route');
  expect(retired).toHaveLength(1);
  expect(retired[0]!.subject).toBe('+14015550200');
  expect(retired[0]!.observedAt).toBe('2026-09-12T09:00:00.000Z');
  expect(retired[0]!.why).toContain('version 2');
});

it('reports truncation honestly instead of a short list that looks complete', () => {
  const raw = fixture.db.raw;
  const account = fixture.repo.create({ commandId: randomUUID(), name: 'Fictional many-handle PM', domain: null });
  expect(account.id).toBeTruthy();
  for (let index = 0; index < 205; index += 1) {
    raw.prepare('INSERT INTO pm_handle_suppression_tombstones VALUES(?,?,?,?,?,?,?)')
      .run(`bulk-${index}`, 'email', `bulk-${index}@example.test`, `2026-09-10T09:00:00.${String(index).padStart(3, '0')}Z`, 'gmail_reply', `evidence-${index}`, PM_NOW);
  }
  const list = readSuppression({ database: fixture.db, clock });
  expect(list.entries).toHaveLength(200);
  expect(list.truncated).toBe(true);
});
