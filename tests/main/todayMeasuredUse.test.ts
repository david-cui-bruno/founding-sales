import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DailyReadService } from '../../src/main/domain/today/dailyReadService';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { AccountCallbackRepository } from '../../src/main/domain/callbacks/accountCallbackRepository';
import { localDateIn } from '../../src/shared/contracts/accountCallbackContract';
import { resolveLocalWeekInterval } from '../../src/main/domain/today/todayOrdering';
import type { WorkerEvent } from '../../src/shared/contracts/delegationContract';
import type { ManualCallOutcome } from '../../src/shared/contracts/accountOutboundContract';

/** The campaign fixture's clock is Wednesday 9 September 2026, 12:00 UTC: 08:00 in America/New_York, the workspace default zone. */
const ZONE = 'America/New_York';

async function fixture() {
  const f = await createCampaignFixture();
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const delegation = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
  delegation.initializeLocalAuthority(f.account.id);
  const delegateCommandId = randomUUID();
  delegation.queueCommand({ commandId: delegateCommandId, workspaceId: f.workspaceId, accountId: f.account.id,
    expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'grant', approvedAt: f.now } });
  const grant: WorkerEvent = { id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 1,
    kind: 'authority.changed', payload: { authority: { accountId: f.account.id, owner: 'worker', generation: 1, state: 'active' },
      receipt: { commandId: delegateCommandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null } } };
  expect(delegation.applyWorkerEvent(grant)).toBe('applied');
  let action = 0;
  const callbacks = new AccountCallbackRepository({ database: f.db, clock: f.clock });
  const read = () => new DailyReadService({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated ID'); } },
    today: services.today, settings: services.workspaceSettings, workspaceId: f.workspaceId }).get();
  const nextVersion = () => delegation.executionVersion(f.account.id)! + 1;
  /** One applied hand-reported call outcome, written by the real local apply path. */
  const report = (outcome: ManualCallOutcome, observedAt: string, note: string | null = null) => {
    action += 1;
    const aggregateVersion = nextVersion();
    const event: WorkerEvent = { id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion,
      kind: 'manual.outcome', receipt: { commandId: randomUUID(), status: 'applied', authorityGeneration: 1, aggregateVersion, reason: null },
      payload: { actionId: `action-${action}`, channel: 'call', outcome, observedAt, evidenceRef: `human-report-${action}`, ...(note === null ? {} : { replyText: note }) } };
    expect(delegation.applyWorkerEvent(event)).toBe('applied');
  };
  /** One consumed call handoff: the durable proof that a call was placed. Prepared and acknowledged through the real seam. */
  const placeCall = (consumedAt: string) => {
    action += 1;
    const expectedVersion = delegation.executionVersion(f.account.id)!;
    const commandId = randomUUID(), handoffId = randomUUID();
    const binding = { actionId: `handoff-${action}`, channel: 'call' as const, routeId: f.routes[0]!.id, routeVersion: 1,
      targetHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), contextRevision: 'ctx-1',
      campaign: { campaignId: f.versions[0]!.campaignId, campaignRevision: 1, enrollmentId: `enrollment-${action}`, enrollmentRevision: 1, stepId: f.versions[0]!.steps[0]!.id } };
    delegation.queueCommand({ commandId, workspaceId: f.workspaceId, accountId: f.account.id,
      expectedAuthorityGeneration: 1, expectedVersion, kind: 'prepare-manual', payload: binding });
    const aggregateVersion = expectedVersion + 1;
    const event: WorkerEvent = { id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion,
      kind: 'manual.handoff', receipt: { commandId, status: 'applied', authorityGeneration: 1, aggregateVersion, reason: null },
      payload: { ...binding, handoffId, expiresAt: '2026-12-31T00:00:00.000Z' } };
    expect(delegation.applyWorkerEvent(event)).toBe('applied');
    // Consuming the handoff is what the phone path records when the call is actually placed.
    f.db.raw.prepare('UPDATE delegated_manual_handoffs SET consumed_at=? WHERE handoff_id=?').run(consumedAt, handoffId);
  };
  /** One inbound reply the worker observed, applied through the real local seam. */
  const observeReply = (observedAt: string) => {
    const aggregateVersion = nextVersion();
    const threadId = `thread-${aggregateVersion}`;
    const messageId = `message-${aggregateVersion}`;
    const event: WorkerEvent = { id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion,
      kind: 'thread.observed', payload: { observedAt, projection: { revision: 1, contextRevision: `ctx-${aggregateVersion}`, thread: {
        accountId: f.account.id, mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: threadId, messages: [
          { id: messageId, threadId, rfcMessageId: null, references: [], from: ['office@example.invalid'], to: ['callie@example.invalid'], cc: [],
            date: observedAt, subject: 'Re: maintenance', bodyParts: [{ mimeType: 'text/plain', text: 'Send me a quote.', truncated: false }] }] },
        signals: [{ kind: 'substantive', evidence: [{ messageId, quote: 'Send me a quote.' }], requiresApproval: true }] },
        approvalInvalidation: { threadId, previousRevision: 0, revision: 1, contextRevision: `ctx-${aggregateVersion}` } } };
    expect(delegation.applyWorkerEvent(event)).toBe('applied');
  };
  return { ...f, services, delegation, callbacks, read, report, placeCall, observeReply };
}

describe('the weekly usage summary is derived from the stored records', () => {
  it('counts a week of mornings, calls, outcomes and notes on the founder-local calendar', async () => {
    const f = await fixture(); try {
      const week = resolveLocalWeekInterval({ generatedAt: f.now, timezone: ZONE });
      expect(week).toMatchObject({ localWeekStart: '2026-09-07', localWeekEnd: '2026-09-13' });
      f.placeCall('2026-09-07T14:00:00.000Z');
      f.placeCall('2026-09-08T14:00:00.000Z');
      f.placeCall('2026-09-09T14:00:00.000Z');
      f.report('connected', '2026-09-07T14:05:00.000Z', 'Asked for the office manager.');
      f.report('interested', '2026-09-08T14:05:00.000Z', 'Wants a quote.');
      f.report('no_answer', '2026-09-09T14:05:00.000Z');
      // Last week: Monday 31 August to Sunday 6 September in New York.
      f.report('wrong_number', '2026-09-04T14:05:00.000Z');

      const usage = f.read().usage;
      expect(usage?.timezone).toBe(ZONE);
      expect(usage?.thisWeek).toMatchObject({ from: '2026-09-07', to: '2026-09-13', mornings: 3, firms: 1, callsPlaced: 3, notes: 2 });
      expect(usage?.thisWeek.outcomes).toEqual({ connected: 1, interested: 1, not_interested: 0, gatekeeper: 0, voicemail: 0, no_answer: 1, busy: 0, wrong_number: 0 });
      expect(usage?.lastWeek).toMatchObject({ from: '2026-08-31', to: '2026-09-06', mornings: 1, callsPlaced: 0, notes: 0 });
      expect(usage?.lastWeek.outcomes.wrong_number).toBe(1);
    } finally { f.close(); }
  });

  it('respects the founder-local date boundary: a late-evening New York call belongs to the day it was made', async () => {
    const f = await fixture(); try {
      // 03:00 UTC on Monday 7 September is 23:00 on Sunday 6 September in New York: last week, not this one.
      f.report('connected', '2026-09-07T03:00:00.000Z');
      // 03:00 UTC on Tuesday 8 September is 23:00 on Monday 7 September in New York: this week.
      f.report('voicemail', '2026-09-08T03:00:00.000Z');
      const usage = f.read().usage;
      expect(localDateIn('2026-09-07T03:00:00.000Z', ZONE)).toBe('2026-09-06');
      expect(usage?.thisWeek.outcomes).toMatchObject({ connected: 0, voicemail: 1 });
      expect(usage?.lastWeek.outcomes).toMatchObject({ connected: 1, voicemail: 0 });
      expect(usage?.thisWeek.mornings).toBe(1);
      expect(usage?.lastWeek.mornings).toBe(1);
    } finally { f.close(); }
  });

  it('counts promised and kept callbacks and never invents a spend figure', async () => {
    const f = await fixture(); try {
      const saved = f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-10', note: 'Ring back Thursday.', sourceCommandId: randomUUID() });
      f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-21', note: null, sourceCommandId: randomUUID() });
      f.callbacks.close({ id: saved.id, expectedRevision: 1, state: 'done' });
      const usage = f.read().usage;
      expect(usage?.thisWeek).toMatchObject({ callbacksPromised: 2, callbacksKept: 1 });
      // Spend is never part of the derived read: the footer's last worker status is the only honest source.
      expect(usage && 'spend' in usage).toBe(false);
    } finally { f.close(); }
  });

  it('leaves the snapshot revision untouched, because the summary is derived and not hashed content', async () => {
    const f = await fixture(); try {
      const before = f.read();
      expect(before.usage?.thisWeek.callbacksPromised).toBe(0);
      const saved = f.callbacks.save({ accountId: f.account.id, dueOn: '2026-09-10', note: null, sourceCommandId: randomUUID() });
      expect(f.read().revision).not.toBe(before.revision);
      // Closing the promise returns the hashed content to exactly what it was, as schema 29 guarantees.
      f.callbacks.close({ id: saved.id, expectedRevision: 1, state: 'done' });
      const after = f.read();
      expect(after.revision).toBe(before.revision);
      // The summary still counts the week's work, so measuring use never changes a stored revision.
      expect(after.usage?.thisWeek).toMatchObject({ callbacksPromised: 1, callbacksKept: 1 });
    } finally { f.close(); }
  });
});

describe('a firm that answered leads the real daily read', () => {
  it('lists the replied firm first and counts the reply in the week', async () => {
    const f = await fixture(); try {
      // No new-firm slots, so nothing but the reply can put this firm on the list.
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=0').run();
      const before = f.read();
      expect(before.calls.accountIds).toEqual([]);
      expect(before.usage?.thisWeek.replies).toBe(0);

      f.observeReply('2026-09-09T11:00:00.000Z');
      const after = f.read();
      expect(after.calls.accountIds[0]).toBe(f.account.id);
      expect(after.answers.filter(answer => answer.kind === 'reply').map(answer => answer.accountId)).toEqual([f.account.id]);
      expect(after.usage?.thisWeek).toMatchObject({ replies: 1, holds: [{ reason: 'reply_capability_unverified', count: 1 }] });
    } finally { f.close(); }
  });

  it('puts the reply ahead of a callback promised for today', async () => {
    const f = await fixture(); try {
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=0').run();
      f.callbacks.save({ accountId: f.account.id, dueOn: localDateIn(f.now, ZONE), note: 'Promised today.', sourceCommandId: randomUUID() });
      expect(f.read().calls.accountIds).toEqual([f.account.id]);
      f.observeReply('2026-09-09T11:00:00.000Z');
      const after = f.read();
      // One firm, listed once: the reply group claims it and the callback group no longer repeats it.
      expect(after.calls.accountIds).toEqual([f.account.id]);
      expect(after.callbacks?.length).toBe(1);
    } finally { f.close(); }
  });
});
