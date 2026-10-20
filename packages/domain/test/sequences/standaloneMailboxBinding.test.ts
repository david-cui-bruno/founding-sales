import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { setProspectingAuthorization } from '../../outreach/authorization.ts';
import { readFence } from '../../outbound/fence.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { pausingAtTokenRefresh, prepareFor, seedFirm } from '../outbound/support/dispatchFixtures.ts';

// Controlled Gmail only. A standalone first-cold sequence has no outreach plan and
// no agreed post-call permission. Mailbox presence alone never authorizes it.
let world: OutboundWorld;
beforeEach(async () => { world = await createOutboundWorld(); }, 180_000);
afterEach(async () => { await world?.stop(); });
const workspace = () => world.alpha.workspace.workspaceId;
const worker = () => world.systemContext(workspace());
const admin = () => repositoryContext(workspaceScope(workspace(), {
  kind: 'user', userId: world.alpha.workspace.admin.userId, role: 'admin',
}), world.database.session);
async function authorize(expectedRevision = 0, enabled = true) {
  return await withTransaction(world.database.session, () => setProspectingAuthorization(admin(), {
    mailboxId: world.alpha.mailboxId, expectedRevision, enabled, basis: 'owner_reported_google_permission',
  }));
}
async function standalone() {
  const firm = await seedFirm(world, world.alpha, 'standalone-first-cold');
  const stepExecutionId = await makeStepExecution(world.database.session, {
    workspaceId: workspace(), firmId: firm.firmId, opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId, templateVersionId: world.alpha.templateVersionId,
    originKind: 'prospecting', zone: 'Etc/UTC',
  });
  const fenceId = await prepareFor(world, world.alpha, firm, { stepExecutionId });
  return { fenceId, stepExecutionId };
}

describe('standalone first-cold mailbox binding acceptance', () => {
  it('binds the exact authorized owner/mailbox without borrowing a post-call permission or plan', async () => {
    expect(await authorize()).toEqual({ ok: true, value: { revision: 1 } });
    const { fenceId, stepExecutionId } = await standalone();
    const { rows } = await world.database.session.query<{
      origin_kind: string; permission_id: string | null; outreach_plan_id: string | null;
      mailbox_id: string; authorization_revision: number; owner_user_id: string;
    }>(`SELECT e.origin_kind,e.permission_id,e.outreach_plan_id,a.mailbox_id,a.authorization_revision,m.owner_user_id
      FROM step_executions x JOIN sequence_enrollments e ON e.workspace_id=x.workspace_id AND e.id=x.enrollment_id
      JOIN outreach_fence_authorizations a ON a.workspace_id=x.workspace_id AND a.fence_id=$3
      JOIN mailboxes m ON m.workspace_id=a.workspace_id AND m.id=a.mailbox_id
      WHERE x.workspace_id=$1 AND x.id=$2`, [workspace(), stepExecutionId, fenceId]);
    expect(rows).toEqual([{
      origin_kind: 'prospecting', permission_id: null, outreach_plan_id: null,
      mailbox_id: world.alpha.mailboxId, authorization_revision: 1,
      owner_user_id: world.alpha.workspace.salesperson.userId,
    }]);
    const gmail = world.clientWith(world.alpha, {});
    const report = await dispatchOutboundMessage(worker(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: fenceId });
    expect(report.outcome, JSON.stringify(report)).toBe('sent');
    expect(gmail.sends).toHaveLength(1);
    expect(gmail.sends[0]?.inReplyTo).toBeUndefined();
    expect(gmail.sends[0]?.threadId).toBeUndefined();
    expect((await readFence(worker(), fenceId))?.state).toBe('sent');
    // At-most-once proof uses the same real dispatch, not a second fake send.
    await dispatchOutboundMessage(worker(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: fenceId });
    expect(gmail.sends).toHaveLength(1);
  });

  it('does not retrofit a fence prepared before explicit mailbox authorization', async () => {
    const { fenceId } = await standalone();
    expect((await authorize()).ok).toBe(true);
    const gmail = world.clientWith(world.alpha, {});
    const report = await dispatchOutboundMessage(worker(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: fenceId });
    expect(report).toMatchObject({ outcome: 'held', refusal: 'step_ineligible' });
    expect(gmail.sends).toHaveLength(0);
  });

  for (const change of ['account', 'generation', 'authorization'] as const) {
    it(`refuses a ${change} change during the token wait before any provider submission`, async () => {
      expect((await authorize()).ok).toBe(true);
      const { fenceId } = await standalone();
      const gmail = world.clientWith(world.alpha, {});
      // The precheck may open a zero-valued day row. Only consumed capacity matters.
      const counters = async () => (await world.database.session.query(
        'SELECT coalesce(sum(automated_sent),0)::int AS sent FROM mailbox_send_days WHERE mailbox_id=$1',
        [world.alpha.mailboxId],
      )).rows;
      const before = await counters();
      const paused = pausingAtTokenRefresh(gmail, async () => {
        if (change === 'authorization') {
          expect((await authorize(1, false)).ok).toBe(true);
        } else {
          await world.database.session.query(change === 'account'
            ? "UPDATE mailboxes SET provider_account_id='changed-account' WHERE workspace_id=$1 AND id=$2"
            : 'UPDATE mailboxes SET generation=generation+1 WHERE workspace_id=$1 AND id=$2',
          [workspace(), world.alpha.mailboxId]);
        }
      });
      const report = await dispatchOutboundMessage(worker(), world.sendDeps(world.alpha, { gmail: paused.client }), { outboundMessageId: fenceId });
      expect(paused.refreshes()).toBe(1);
      expect(report.outcome).not.toBe('sent');
      expect(gmail.sends).toHaveLength(0);
      expect(await counters()).toEqual(before);
      expect(await readFence(worker(), fenceId)).toMatchObject({ dispatchStartedAt: null, attemptToken: null });
      if (change === 'generation') expect(report).toMatchObject({
        outcome: 'not_ready', refusal: 'fence_not_ready', detail: 'mailbox_changed',
      });
    });
  }
});
