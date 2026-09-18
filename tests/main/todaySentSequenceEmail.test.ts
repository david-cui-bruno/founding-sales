import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DailyReadService } from '../../src/main/domain/today/dailyReadService';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { readUsageSummary } from '../../src/main/domain/usage/usageReadService';
import { sentTemplateEmailLine } from '../../src/renderer/features/today/todayCopy';
import { templateSequenceEmailActionId } from '../../src/shared/outreach/templateSequenceEmail';
import type { WorkerEvent } from '../../src/shared/contracts/delegationContract';

/** The campaign fixture's clock is Wednesday 9 September 2026, 12:00 UTC: 08:00 in America/New_York, the workspace default zone. */
const ZONE = 'America/New_York';

/**
 * Today says a sequence email went out (D13, lane 40). On a real migrated encrypted workspace database,
 * with the worker's own `action.outcome` event applied through the real `DelegationRepository`. Nothing
 * here sends, dials or reads a provider: the event is the only thing that says an email was accepted.
 */
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
  const read = () => new DailyReadService({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated ID'); } },
    today: services.today, settings: services.workspaceSettings, workspaceId: f.workspaceId }).get();
  const usage = (accountIds: string[] = [f.account.id]) =>
    readUsageSummary(f.db, { workspaceId: f.workspaceId, accountIds, generatedAt: f.now, timezone: ZONE });
  /** One accepted send, exactly as the worker's dispatch path publishes it. `actionId` is whatever the caller names. */
  const accept = (actionId: string, observedAt: string, state: 'provider_accepted' | 'cancelled' = 'provider_accepted') => {
    const aggregateVersion = delegation.executionVersion(f.account.id)! + 1;
    const event: WorkerEvent = { id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion,
      kind: 'action.outcome', payload: { actionId, state, contentHash: 'a'.repeat(64), targetHash: 'b'.repeat(64),
        observedAt, evidenceRef: `send-${actionId}` } };
    expect(delegation.applyWorkerEvent(event)).toBe('applied');
  };
  const step = (templateId: 'T4' | 'T5', stepId: string) =>
    templateSequenceEmailActionId({ accountId: f.account.id, templateId, stepId });
  return { ...f, services, delegation, read, usage, accept, step };
}

describe('Today says a sequence email went out', () => {
  it('puts the template, the firm and the local day on the morning list and counts the send in the week', async () => {
    const f = await fixture(); try {
      // Nothing sent yet: the field is absent, so the snapshot revision is exactly what it was.
      const before = f.read();
      expect(before.calls.sentTemplateEmails).toBeUndefined();
      expect(f.usage().thisWeek.emailsSent).toBe(0);

      const t4 = f.step('T4', 'territory-version-step-2');
      f.accept(t4, '2026-09-08T18:30:00.000Z');
      const after = f.read();
      expect(after.calls.sentTemplateEmails).toEqual([{ accountId: f.account.id, templateId: 'T4',
        sentOn: '2026-09-08', actionId: t4 }]);
      // A send is real content, so the revision moves; nothing else about the snapshot changed.
      expect(after.revision).not.toBe(before.revision);
      expect(after.freshness.kind).toBe('local_snapshot');
      expect(after.issues).toEqual([]);
      // The exact line Today reads, from the template the action id names and the local day in the founder's zone.
      const sent = after.calls.sentTemplateEmails![0]!;
      expect(sentTemplateEmailLine(sent.templateId, f.account.name, sent.sentOn)).toBe(`Sent T4 to ${f.account.name} on 2026-09-08`);
      expect(f.usage().thisWeek.emailsSent).toBe(1);

      // The second step of the sequence, on its own day, reads as its own line.
      const t5 = f.step('T5', 'territory-version-step-4');
      f.accept(t5, '2026-09-09T11:00:00.000Z');
      const both = f.read();
      expect(both.calls.sentTemplateEmails!.map(email => [email.templateId, email.sentOn])).toEqual([['T4', '2026-09-08'], ['T5', '2026-09-09']]);
      expect(f.usage().thisWeek.emailsSent).toBe(2);
      // Reading twice from the same database gives the same snapshot: the read measures, it never writes.
      expect(f.read()).toEqual(both);
    } finally { f.close(); }
  });

  it('renders nothing new for an outcome whose action id names no template, and never counts one that was not accepted', async () => {
    const f = await fixture(); try {
      // An ordinary reply dispatch: a real accepted send whose action is not a template sequence step.
      f.accept('action-reply-1', '2026-09-08T18:30:00.000Z');
      expect(f.read().calls.sentTemplateEmails).toBeUndefined();
      expect(f.usage().thisWeek.emailsSent).toBe(0);

      // A template step the provider refused. A cancelled outcome is not a send and says nothing on Today.
      f.accept(f.step('T4', 'territory-version-step-2'), '2026-09-08T19:00:00.000Z', 'cancelled');
      expect(f.read().calls.sentTemplateEmails).toBeUndefined();
      expect(f.usage().thisWeek.emailsSent).toBe(0);

      // A send for a firm the summary's scope does not name is not counted for that scope.
      f.accept(f.step('T5', 'territory-version-step-4'), '2026-09-09T11:00:00.000Z');
      expect(f.usage().thisWeek.emailsSent).toBe(1);
      expect(f.usage([]).thisWeek.emailsSent).toBe(0);
      // Last week's window never borrows this week's send.
      expect(f.usage().lastWeek.emailsSent).toBe(0);
    } finally { f.close(); }
  });
});
