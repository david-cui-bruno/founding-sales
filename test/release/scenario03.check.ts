import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@fss/domain/db';
import { decideSend, dispatchOutboundMessage, readFence } from '@fss/domain/outbound';
import { openHold } from '@fss/domain/policy';
import {
  createOutboundWorld,
  type OutboundWorld,
} from '../../packages/domain/test/outbound/support/outboundWorld.ts';
import {
  openExtraSession,
  pausingAtTokenRefresh,
  prepareFor,
  seedFirm,
  type ExtraSession,
} from '../../packages/domain/test/outbound/support/dispatchFixtures.ts';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 3: "Worker pauses after eligibility read, reply commits, worker resumes: no
 * external action after the reply linearizes."
 *
 * The scenario is about an interleaving, not about a rule: the worker decided this send
 * was eligible, something committed, and the worker woke up. Everything turns on whether
 * the decision it made earlier is still the decision it acts on.
 *
 * ## The vacuous-pass trap
 *
 * Asserting only that a held send is refused proves the gate reads holds. Until lane
 * g77 this check did exactly that: it committed the reply's hold and *then* called the
 * dispatch, so the dispatch read the hold like any other and the window the scenario is
 * about — between the dispatch's own eligibility read and its claim, where the token
 * refresh sits — was never entered (audit T02). A dispatch that claimed on its first
 * answer would have passed.
 *
 * Closed by pausing the real dispatch inside that window. The Gmail client's token
 * refresh is step 3 of `dispatchOutboundMessage`: the precheck has read the world and
 * found it sendable, and the claiming transaction has not begun. The reply's hold
 * commits there, on another connection, and the check requires no send and the fence
 * held for the reply's own reason. The control runs the identical pause committing
 * nothing and requires the send, so the refusal is the reply and nothing else.
 * `packages/domain/test/outbound/dispatchRace.test.ts` carries the rest: a confirmed
 * reply, an opt-out, and the send gate serializing a claim with a reply in both orders.
 */

let world: OutboundWorld;
let replying: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  replying = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await replying?.close();
  await world?.stop();
});

describe('Appendix G 3: a reply that commits between the decision and the dispatch', () => {
  mustCover(3, ['decideSend', 'lockSendGateForDispatch', 'pausingAtTokenRefresh']);

  it('a reply committed inside the dispatch, after its eligibility read, stops the send', async () => {
    const workspaceId = world.alpha.workspace.workspaceId;
    const context = world.systemContext(workspaceId);
    const firm = await seedFirm(world, world.alpha, 'scenario-3');
    const fenceId = await prepareFor(world, world.alpha, firm);

    // The eligibility read the worker makes before it pauses must be `ok`, or the
    // refusal below would prove nothing: a world that can never send refuses for free.
    const fence = await readFence(context, fenceId);
    expect((await decideSend(context, fence!, world.sendDeps(world.alpha))).ok).toBe(true);

    const gmail = world.clientWith(world.alpha, {});
    const paused = pausingAtTokenRefresh(gmail, async () => {
      // ... and the reply linearizes, on another connection: 12.4's "every possibly
      // relevant incoming message creates a hold before classification can release
      // anything", through the same `openHold` the mail pipeline calls.
      await withTransaction(replying.session, async () => {
        await openHold(replying.context(workspaceId), {
          scopeKind: 'opportunity',
          scopeKey: firm.opportunityId,
          reasonCode: 'uncertain_reply',
          blockedActionKinds: ['email_send', 'enrollment_advance'],
          sourceEventKind: 'mail_message',
          recoveryAction: 'confirm_reply',
        });
      });
    });

    const report = await dispatchOutboundMessage(context, world.sendDeps(world.alpha, { gmail: paused.client }), {
      outboundMessageId: fenceId,
    });

    // The pause happened after the precheck passed: OAuth runs only for a sendable fence.
    expect(paused.refreshes()).toBe(1);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail ?? '').toMatch(/^uncertain_reply/);
    // The assertion that matters: nothing left the process after the reply committed.
    expect(gmail.sends).toHaveLength(0);
    expect((await readFence(context, fenceId))?.state).toBe('held');
  });

  it('and the same pause committing nothing sends, so the refusal was the reply', async () => {
    const workspaceId = world.alpha.workspace.workspaceId;
    const context = world.systemContext(workspaceId);
    const firm = await seedFirm(world, world.alpha, 'scenario-3-control');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const gmail = world.clientWith(world.alpha, {});
    const paused = pausingAtTokenRefresh(gmail, async () => {
      await Promise.resolve();
    });
    const report = await dispatchOutboundMessage(context, world.sendDeps(world.alpha, { gmail: paused.client }), {
      outboundMessageId: fenceId,
    });
    expect(paused.refreshes()).toBe(1);
    expect(report.outcome).toBe('sent');
    expect(gmail.sends).toHaveLength(1);
  });
});
