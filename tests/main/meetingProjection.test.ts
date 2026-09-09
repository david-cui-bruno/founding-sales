import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { workerEventSchema } from '../../src/shared/contracts/delegationContract';
import type { MeetingOutcome } from '../../src/shared/contracts/meetingContract';
const now = '2026-09-14T12:00:00.000Z';
async function fixture() {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey(); let db = openDatabase({ path: temp.path, key });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  const account = new AccountRepository({ database: db, clock: { now: () => now }, ids: { next: randomUUID } }).create({ commandId: randomUUID(), name: 'Fictional Calendar PM', domain: null });
  const repository = () => new DelegationRepository({ database: db, workspaceId: 'ws-fiction', clock: { now: () => now } });
  repository().initializeLocalAuthority(account.id);
  const command = { commandId: randomUUID(), workspaceId: 'ws-fiction', accountId: account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate' as const, payload: { delegationId: 'delegation-fiction', approvedAt: now } };
  repository().queueCommand(command);
  repository().applyWorkerEvent({ id: randomUUID(), workspaceId: 'ws-fiction', accountId: account.id, authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.changed', payload: {
    authority: { accountId: account.id, owner: 'worker', generation: 1, state: 'active' }, receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null },
  } });
  const identity = { meetingId: 'meeting-fiction', calendarId: 'founder@example.test', providerEventId: 'a'.repeat(64) };
  const booked: MeetingOutcome = { ...identity, status: 'booked', reason: null, event: { ...identity, status: 'confirmed', etag: '"v1"', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', attendees: [{ email: 'prospect@example.test', responseStatus: 'needsAction' }], meetUrl: null } };
  const event = (version: number, outcome = booked) => workerEventSchema.parse({ id: `event-fiction-${version}`, workspaceId: 'ws-fiction', accountId: account.id, authorityGeneration: 1, aggregateVersion: version, kind: 'meeting.outcome', payload: { commandId: 'command-fiction', outcome, observedAt: now } });
  return { repository, account, booked, event, row: () => db.raw.prepare('SELECT * FROM delegated_meetings').get() as { state: string; revision: number; projection_json: string; provider_event_id: string } | undefined,
    reopen: () => { closeDatabase(db); db = openDatabase({ path: temp.path, key }); }, close: () => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}
describe('real encrypted delegated_meetings event projection', () => {
  it('persists actual provider identity and invitation response through close/reopen and duplicate replay', async () => {
    const f = await fixture(); try {
      expect(f.repository().applyWorkerEvent(f.event(2))).toBe('applied');
      f.reopen();
      expect(f.row()).toMatchObject({ state: 'created', revision: 1, provider_event_id: 'a'.repeat(64) });
      expect(JSON.parse(f.row()!.projection_json)).toMatchObject({ outcome: { status: 'booked', event: { attendees: [{ responseStatus: 'needsAction' }] } } });
      expect(f.repository().applyWorkerEvent(f.event(2))).toBe('duplicate');
      expect(f.row()!.revision).toBe(1);
    } finally { f.close(); }
  });
  it('keeps cancellation terminal against late booked evidence and rejects identity replacement', async () => {
    const f = await fixture(); try {
      f.repository().applyWorkerEvent(f.event(2));
      f.repository().applyWorkerEvent(f.event(3, { ...f.booked, status: 'cancelled', event: { ...f.booked.event!, status: 'cancelled', etag: '"v2"' } }));
      f.repository().applyWorkerEvent(f.event(4));
      expect(f.row()!.state).toBe('cancelled');
      expect(() => f.repository().applyWorkerEvent(f.event(5, { ...f.booked, providerEventId: 'b'.repeat(64), event: { ...f.booked.event!, providerEventId: 'b'.repeat(64) } }))).toThrow();
      expect(f.row()!.provider_event_id).toBe('a'.repeat(64));
    } finally { f.close(); }
  });
  it('projects an original-generation cancellation after revocation only for the exact previously reserved identity', async () => {
    const f = await fixture(); try {
      f.repository().applyWorkerEvent(f.event(2, { ...f.booked, status: 'unknown', reason: 'reservation_pending', event: null }));
      const command = { commandId: randomUUID(), workspaceId: 'ws-fiction', accountId: f.account.id, expectedAuthorityGeneration: 1, expectedVersion: 2, kind: 'revoke' as const, payload: { reason: 'Fictional revoke' } };
      f.repository().queueCommand(command);
      f.repository().applyWorkerEvent({ id: randomUUID(), workspaceId: 'ws-fiction', accountId: f.account.id, authorityGeneration: 2, aggregateVersion: 3, kind: 'authority.changed', payload: {
        authority: { accountId: f.account.id, owner: 'worker', generation: 2, state: 'revoked' }, receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 2, aggregateVersion: 3, reason: null },
      } });
      expect(f.repository().applyWorkerEvent(f.event(4, { ...f.booked, status: 'cancelled', event: { ...f.booked.event!, status: 'cancelled' } }))).toBe('applied');
      expect(f.row()!.state).toBe('cancelled');
      expect(f.repository().authority(f.account.id)).toMatchObject({ generation: 2, state: 'revoked' });
    } finally { f.close(); }
  });
  it('rejects booked-without-provider and cross-event identity forgery at the wire boundary', async () => {
    const f = await fixture(); try {
      expect(() => f.event(2, { ...f.booked, event: null })).toThrow();
      expect(() => f.event(2, { ...f.booked, event: { ...f.booked.event!, providerEventId: 'b'.repeat(64) } })).toThrow();
    } finally { f.close(); }
  });
  it('does not project a gap or a future observation', async () => {
    const f = await fixture(); try {
      expect(f.repository().applyWorkerEvent(f.event(3))).toBe('gap'); expect(f.row()).toBeUndefined();
      const event = f.event(2); if (event.kind !== 'meeting.outcome') throw new Error();
      expect(() => f.repository().applyWorkerEvent({ ...event, payload: { ...event.payload, observedAt: '2026-09-16T00:00:00.000Z' } })).toThrow();
      expect(f.row()).toBeUndefined();
    } finally { f.close(); }
  });
});
