import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimForDispatch, dispatchOutboundMessage, readFence } from '@fss/domain/outbound';
import {
  createOutboundWorld,
  type OutboundWorld,
} from '../../packages/domain/test/outbound/support/outboundWorld.ts';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 16: "Reassignment races a due send from the former owner's mailbox;
 * dispatching reconciles there and future work rebinds."
 *
 * Appendix A's reassignment row says it exactly: "dispatching mail remains with the
 * former mailbox and reconciles there". The reason is Appendix B rather than policy — a
 * fence in `dispatching` may have already reached Gmail through that mailbox, and only
 * that mailbox's Sent folder can settle it. Rebinding it to the new owner would mean
 * searching the wrong Sent folder and eventually resending.
 *
 * ## The vacuous-pass trap
 *
 * A reassignment applied *before* the fence exists rebinds trivially, because there is
 * nothing to leave behind. That is the easy version of this test and it proves nothing
 * about the race.
 *
 * Closed by reassigning while the fence is already `dispatching`: the fence must still
 * name the former mailbox afterwards, and no second worker may send it.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

describe('Appendix G 16: reassignment races a dispatching fence', () => {
  mustCover(16, ['claimForDispatch', 'dispatching']);

  it('leaves a dispatching fence with the former owner mailbox', async () => {
    const workspaceId = world.alpha.workspace.workspaceId;
    const context = world.systemContext(workspaceId);
    await world.clearHolds(workspaceId);

    const fenceId = await world.prepare(world.alpha);
    const prepared = await readFence(context, fenceId);
    expect(prepared?.state).toBe('prepared');
    const formerMailboxId = prepared!.mailboxId;

    // The worker claims it: the atomic prepared → dispatching that authorises one call.
    const claim = await claimForDispatch(context, { outboundMessageId: fenceId, actor: 'former-owner' });
    expect(claim.ok).toBe(true);

    // ... and the firm is reassigned while that claim is in flight.
    await context.db.query(
      'UPDATE firms SET assigned_user_id = $3 WHERE workspace_id = $1 AND id = $2',
      [workspaceId, prepared!.firmId, world.alpha.workspace.admin.userId],
    );

    const afterReassignment = await readFence(context, fenceId);
    expect(afterReassignment?.state).toBe('dispatching');
    // The whole point: the envelope froze when dispatch began and the mailbox with it.
    expect(afterReassignment?.mailboxId).toBe(formerMailboxId);
  });

  it('and no second worker may send it, whoever the firm now belongs to', async () => {
    const workspaceId = world.alpha.workspace.workspaceId;
    const context = world.systemContext(workspaceId);
    const fenceId = await world.prepare(world.alpha);
    await claimForDispatch(context, { outboundMessageId: fenceId, actor: 'former-owner' });

    const sendsBefore = world.alpha.gmail.calls.filter(call => call.method === 'sendMessage').length;
    const report = await dispatchOutboundMessage(context, world.sendDeps(world.alpha), {
      outboundMessageId: fenceId,
    });
    // `dispatching` never returns to `prepared`, irrespective of job leases, so the
    // second process is told the fence is not ready rather than being allowed to send.
    expect(report.outcome).toBe('not_ready');
    expect(world.alpha.gmail.calls.filter(call => call.method === 'sendMessage').length).toBe(sendsBefore);
  });

  it('a fresh fence after the reassignment is preparable, so the refusal was the claim', async () => {
    // The control. Without it, "not_ready" could mean the world had stopped working.
    const workspaceId = world.alpha.workspace.workspaceId;
    const context = world.systemContext(workspaceId);
    await world.clearHolds(workspaceId);
    const fenceId = await world.prepare(world.alpha);
    expect((await readFence(context, fenceId))?.state).toBe('prepared');
  });
});
