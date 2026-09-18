import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DailyReadService } from '../../src/main/domain/today/dailyReadService';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { heldTemplateEmailLine } from '../../src/renderer/features/today/todayCopy';
import type { ReplyTemplateHoldReason } from '../../src/shared/contracts/replyTemplateContract';
import type { WorkerEvent } from '../../src/shared/contracts/delegationContract';

/**
 * Today says which email step of a firm's sequence is held and why (D13, lane 41). On a real migrated
 * encrypted workspace database, with the worker's own `territory.steps_held` event applied through the
 * real `DelegationRepository`. Nothing here sends, dials, drafts or reads a provider: the event is the
 * only thing that says a step is held, and reading it clears nothing.
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
  /** The worker's own statement of what is held for this firm, exactly as the enrollment record publishes it. */
  const hold = (steps: { stepId: string; templateId: 'T4' | 'T5'; reason: ReplyTemplateHoldReason }[],
    observedAt = '2026-09-09T11:00:00.000Z', accountId = f.account.id) => {
    const aggregateVersion = delegation.executionVersion(accountId)! + 1;
    const event: WorkerEvent = { id: randomUUID(), workspaceId: f.workspaceId, accountId, authorityGeneration: 1, aggregateVersion,
      kind: 'territory.steps_held', payload: { policyId: 'territory-policy-fictional', enrollmentId: 'territory-enrollment-fictional',
        observedAt, heldSteps: steps } };
    return delegation.applyWorkerEvent(event);
  };
  return { ...f, services, delegation, read, hold };
}

const T4_STEP = 'territory-version-step-2';
const T5_STEP = 'territory-version-step-4';

describe('Today says which email step is held and why', () => {
  it('puts one sentence per held step on the morning list, naming the frozen template and the worker\'s own reason', async () => {
    const f = await fixture(); try {
      // Nothing held yet: the field is absent, so the snapshot revision is exactly what it was.
      const before = f.read();
      expect(before.calls.heldTemplateEmails).toBeUndefined();

      expect(f.hold([{ stepId: T4_STEP, templateId: 'T4', reason: 'template_not_approved' },
        { stepId: T5_STEP, templateId: 'T5', reason: 'template_not_approved' }])).toBe('applied');
      const after = f.read();
      expect(after.calls.heldTemplateEmails).toEqual([
        { accountId: f.account.id, templateId: 'T4', stepId: T4_STEP, reason: 'template_not_approved' },
        { accountId: f.account.id, templateId: 'T5', stepId: T5_STEP, reason: 'template_not_approved' }]);
      // A held step is real content, so the revision moves; nothing else about the snapshot changed.
      expect(after.revision).not.toBe(before.revision);
      expect(after.freshness.kind).toBe('local_snapshot');
      expect(after.issues).toEqual([]);
      // Reading twice from the same database gives the same snapshot: the read measures, it never writes.
      expect(f.read()).toEqual(after);
      // The exact sentences, from the template the step froze and the reason the worker's decision gave.
      expect(after.calls.heldTemplateEmails!.map(held => heldTemplateEmailLine(held.templateId, held.reason)))
        .toEqual(['Email step T4 held: template not approved', 'Email step T5 held: template not approved']);
    } finally { f.close(); }
  });

  it('reads only the newest statement for a firm, so a reason that changed is never shown beside the one it replaced', async () => {
    const f = await fixture(); try {
      expect(f.hold([{ stepId: T4_STEP, templateId: 'T4', reason: 'template_not_approved' }])).toBe('applied');
      // David approves the template; the mailbox is still not configured for this firm.
      expect(f.hold([{ stepId: T4_STEP, templateId: 'T4', reason: 'mailbox_not_connected' }], '2026-09-09T11:05:00.000Z')).toBe('applied');
      const after = f.read();
      expect(after.calls.heldTemplateEmails).toEqual([{ accountId: f.account.id, templateId: 'T4', stepId: T4_STEP, reason: 'mailbox_not_connected' }]);
      expect(heldTemplateEmailLine('T4', after.calls.heldTemplateEmails![0]!.reason)).toBe('Email step T4 held: mailbox not connected');

      // The step goes out. The worker publishes the empty set, and Today stops saying anything is held for the firm.
      expect(f.hold([], '2026-09-09T11:10:00.000Z')).toBe('applied');
      expect(f.read().calls.heldTemplateEmails).toBeUndefined();
    } finally { f.close(); }
  });

  it('has one sentence for each of the five closed reasons and says nothing about a firm outside the morning list', async () => {
    const f = await fixture(); try {
      expect((['template_not_approved', 'mailbox_not_connected', 'no_business_email', 'sender_cap_reached',
        'template_variable_missing'] as const).map(reason => heldTemplateEmailLine('T2', reason))).toEqual([
        'Email step T2 held: template not approved',
        'Email step T2 held: mailbox not connected',
        'Email step T2 held: no business email',
        'Email step T2 held: sender cap reached',
        'Email step T2 held: template variable missing']);

      // A statement about an account this workspace's snapshot does not carry is not shown as one of its firms.
      expect(f.hold([{ stepId: T4_STEP, templateId: 'T4', reason: 'sender_cap_reached' }])).toBe('applied');
      const after = f.read();
      expect(after.calls.heldTemplateEmails).toHaveLength(1);
      expect(after.calls.heldTemplateEmails![0]!.accountId).toBe(f.account.id);
      expect(after.issues.some(issue => issue.code === 'scope_mismatch')).toBe(false);
    } finally { f.close(); }
  });
});
