import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DailyReadService } from '../../src/main/domain/today/dailyReadService';
import { AccountCallbackRepository } from '../../src/main/domain/callbacks/accountCallbackRepository';
import { addBusinessDays, localDateIn } from '../../src/shared/contracts/accountCallbackContract';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';

const COMMAND = 'f0e1d2c3-4b5a-4968-8778-6a5b4c3d2e1f';

async function fixture() {
  const f = await createCampaignFixture();
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const callbacks = new AccountCallbackRepository({ database: f.db, clock: f.clock });
  const read = () => new DailyReadService({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated ID'); } },
    today: services.today, settings: services.workspaceSettings, workspaceId: f.workspaceId }).get();
  return { ...f, services, callbacks, read };
}

describe('promised callbacks (schema 29)', () => {
  it('saves one row per human report, is idempotent on replay and refuses a changed promise for the same report', async () => {
    const f = await fixture(); try {
      const saved = f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-25', note: 'Call the office manager back.', sourceCommandId: COMMAND });
      expect(saved).toMatchObject({ accountId: f.account.id, dueOn: '2026-09-25', note: 'Call the office manager back.', state: 'open', revision: 1, sourceCommandId: COMMAND });
      // An uncertain result never promises twice: the exact same report reaches the exact same row.
      expect(f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-25', note: 'Call the office manager back.', sourceCommandId: COMMAND })).toEqual(saved);
      expect(f.db.raw.prepare('SELECT COUNT(*) AS count FROM pm_account_callbacks').get()).toEqual({ count: 1 });
      expect(() => f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-26', note: 'Call the office manager back.', sourceCommandId: COMMAND })).toThrow(/account_callback_conflict/);
      expect(() => f.callbacks.save({ accountId: 'no-such-firm', dueOn: '2026-09-25', note: null, sourceCommandId: randomUUID() })).toThrow(/account_callback_unknown_account/);
    } finally { f.close(); }
  });
  it('closes a promise in place, never deletes it and refuses a stale revision or a second close', async () => {
    const f = await fixture(); try {
      const saved = f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-25', note: null, sourceCommandId: COMMAND });
      expect(() => f.callbacks.close({ id: saved.id, expectedRevision: 2, state: 'done' })).toThrow(/account_callback_revision_conflict/);
      const done = f.callbacks.close({ id: saved.id, expectedRevision: 1, state: 'done' });
      expect(done).toMatchObject({ id: saved.id, state: 'done', revision: 2, dueOn: '2026-09-25' });
      expect(() => f.callbacks.close({ id: saved.id, expectedRevision: 2, state: 'cancelled' })).toThrow(/account_callback_already_closed/);
      expect(() => f.db.raw.prepare('DELETE FROM pm_account_callbacks WHERE id=?').run(saved.id)).toThrow(/Account callback history is immutable/);
      expect(f.callbacks.listOpen([f.account.id])).toEqual([]);
    } finally { f.close(); }
  });
  it('lists a callback first on Today on its day, with its note, and not before its day', async () => {
    const f = await fixture(); try {
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=0').run();
      const timezone = f.services.workspaceSettings.read().timezone;
      const today = localDateIn(f.now, timezone);
      const tomorrow = addBusinessDays(today, 1);
      f.callbacks.save({ accountId: f.account.id, dueOn: tomorrow, note: 'They asked for a call tomorrow.', sourceCommandId: COMMAND });
      const early = f.read();
      expect(early.calls.accountIds).not.toContain(f.account.id);
      expect(early.callbacks).toEqual([expect.objectContaining({ accountId: f.account.id, dueOn: tomorrow, note: 'They asked for a call tomorrow.', state: 'open' })]);

      f.callbacks.save({ accountId: f.account.id, dueOn: today, note: 'Promised today.', sourceCommandId: randomUUID() });
      const snapshot = f.read();
      expect(snapshot.calls.accountIds[0]).toBe(f.account.id);
      expect(snapshot.callbacks?.map(callback => callback.dueOn)).toEqual([today, tomorrow]);
      // Real content: a promise changes the snapshot revision, unlike the derived allocation.
      expect(snapshot.revision).not.toBe(early.revision);
    } finally { f.close(); }
  });
  it('an empty callback list leaves the stored snapshot revision exactly as it was before schema 29', async () => {
    const f = await fixture(); try {
      const before = f.read();
      expect(before.callbacks).toBeUndefined();
      f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-25', note: null, sourceCommandId: COMMAND });
      const withPromise = f.read();
      expect(withPromise.revision).not.toBe(before.revision);
      const closed = f.callbacks.listOpen([f.account.id])[0]!;
      f.callbacks.close({ id: closed.id, expectedRevision: 1, state: 'cancelled' });
      expect(f.read().revision).toBe(before.revision);
    } finally { f.close(); }
  });
});

describe('the desktop due rule reads the timing the worker carries', () => {
  it('lists a later call step due now and leaves a resting enrollment off the list', async () => {
    const f = await fixture(); try {
      const version = { ...f.versions[0]!, id: randomUUID(), campaignId: randomUUID(), version: 1, steps: [
        { id: 'step-one', channel: 'call' as const, condition: 'initial' as const, delayHours: 0 },
        { id: 'step-two', channel: 'call' as const, condition: 'no_reply' as const, delayHours: 72 },
      ] };
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=0').run();
      f.repo.createVersion({ commandId: randomUUID(), version });
      f.repo.approve({ commandId: randomUUID(), campaignVersionId: version.id, snapshotHash: accountFingerprint(version), approvedAt: f.now });
      const enrollment = f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0]!.id, campaignVersionId: version.id, executionContextId: 'ctx', contextRevision: 1 });
      const project = (patch: Record<string, unknown>) => f.db.raw.transaction(() => f.repo.applyProjection(f.account.id, { commandId: randomUUID(), version: null,
        enrollment: { ...enrollment, version: enrollment.version + 1, ...patch }, evidence: null }))();

      // Step two, whose version delay has not elapsed, is due because the worker says so.
      project({ currentStepId: 'step-two', nextDueAt: f.now });
      expect(f.read().calls.accountIds).toEqual([f.account.id]);
      expect(f.read().issues.find(issue => issue.code === 'call_due_unknown')).toBeUndefined();

      // A later branch date is not due yet, and stays honest rather than unknown.
      project({ currentStepId: 'step-two', version: enrollment.version + 2, nextDueAt: '2026-10-01T12:00:00.000Z' });
      expect(f.read().calls.accountIds).toEqual([]);
      expect(f.read().issues.find(issue => issue.code === 'call_due_unknown')).toBeUndefined();

      // A rested firm is paused: never due, whatever timing it carries.
      project({ currentStepId: 'step-two', version: enrollment.version + 3, state: 'paused', nextDueAt: f.now, restingUntil: '2027-03-18T12:00:00.000Z' });
      expect(f.read().calls.accountIds).toEqual([]);

      // Without carried timing a later step is still honestly unknown, exactly as before.
      project({ currentStepId: 'step-two', version: enrollment.version + 4, state: 'active' });
      expect(f.read().issues).toContainEqual({ code: 'call_due_unknown', count: 1 });
    } finally { f.close(); }
  });
});

describe('business-day arithmetic', () => {
  it('counts weekdays only and rolls a weekend landing to the next Monday', () => {
    expect(addBusinessDays('2026-09-18', 0)).toBe('2026-09-18'); // Friday
    expect(addBusinessDays('2026-09-18', 1)).toBe('2026-09-21'); // Monday
    expect(addBusinessDays('2026-09-18', 3)).toBe('2026-09-23');
    expect(addBusinessDays('2026-09-19', 0)).toBe('2026-09-21'); // Saturday rolls forward
    expect(addBusinessDays('2026-09-18', 5)).toBe('2026-09-25');
    expect(() => addBusinessDays('2026-09-31', 1)).toThrow();
    expect(() => addBusinessDays('2026-09-18', -1)).toThrow(/callback_business_days_range/);
  });
  it('reads the firm local date of an instant and refuses an unreadable one', () => {
    expect(localDateIn('2026-09-19T03:00:00.000Z', 'America/New_York')).toBe('2026-09-18');
    expect(localDateIn('2026-09-19T03:00:00.000Z', 'UTC')).toBe('2026-09-19');
    expect(() => localDateIn('not an instant', 'UTC')).toThrow(/callback_instant_unreadable/);
  });
});
