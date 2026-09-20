import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideSend, dispatchOutboundMessage, readFence } from '@fss/domain/outbound';
import {
  createOutboundWorld,
  type OutboundWorld,
} from '../../packages/domain/test/outbound/support/outboundWorld.ts';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 3: "Worker pauses after eligibility read, reply commits, worker resumes: no
 * external action after the reply linearizes."
 *
 * The scenario is about an interleaving, not about a rule: the worker decided this send
 * was eligible, something committed, and the worker woke up. Everything turns on whether
 * the decision it made earlier is still the decision it acts on.
 *
 * `packages/domain/outbound/gate.ts` answers it by construction — "nothing here trusts a
 * value the caller computed" — and `decideSend` runs inside the dispatching transaction.
 * But a comment is not a test, and no lane suite pauses *between* a successful decision
 * and the dispatch.
 *
 * ## The vacuous-pass trap
 *
 * Asserting only that a suppressed send is refused proves the gate reads suppressions. It
 * says nothing about whether an *earlier* answer can be reused, which is what this
 * scenario is about. A gate that cached its first decision would pass that test and fail
 * this one.
 *
 * Closed by deciding once and keeping the answer, committing the reply's hold, and then
 * dispatching the same fence: the first decision must have been `ok`, so the refusal
 * cannot be explained by a world that could never send, and the Gmail fake must have
 * recorded no send at all.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

describe('Appendix G 3: a reply that commits between the decision and the dispatch', () => {
  mustCover(3, ['decideSend', 'It re-reads everything']);

  it('re-decides on the fence rather than acting on the answer it already had', async () => {
    const workspaceId = world.alpha.workspace.workspaceId;
    const context = world.systemContext(workspaceId);
    await world.clearHolds(workspaceId);

    const fenceId = await world.prepare(world.alpha);
    const fence = await readFence(context, fenceId);
    expect(fence).not.toBeNull();

    // The eligibility read the worker made before it paused. This must be `ok`, or the
    // refusal below would prove nothing: a world that can never send refuses for free.
    const before = await decideSend(context, fence!, world.sendDeps(world.alpha));
    expect(before.ok).toBe(true);

    // ... and now the reply linearizes: 12.4's "every possibly relevant incoming message
    // creates a hold before classification can release anything".
    await context.db.query(
      `INSERT INTO active_holds
         (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
          source_event_kind, source_event_id, started_at)
       VALUES ($1, 'firm', $2, 'uncertain_reply', ARRAY['email_send','enrollment_advance'],
               'mail_message', gen_random_uuid(), now())`,
      [workspaceId, fence!.firmId],
    );

    const sendsBefore = world.alpha.gmail.calls.filter(call => call.method === 'sendMessage').length;

    // The worker resumes. It holds the same fence and the same earlier decision.
    const after = await decideSend(context, fence!, world.sendDeps(world.alpha));
    expect(after.ok).toBe(false);
    expect(after.ok === false ? after.reason : null).toBe('provider_refusal');

    const report = await dispatchOutboundMessage(context, world.sendDeps(world.alpha), {
      outboundMessageId: fenceId,
    });
    expect(report.outcome).toBe('held');

    // The assertion that matters: nothing left the process after the reply committed.
    const sendsAfter = world.alpha.gmail.calls.filter(call => call.method === 'sendMessage').length;
    expect(sendsAfter).toBe(sendsBefore);

    const held = await readFence(context, fenceId);
    expect(held?.state).toBe('held');
  });

  it('and the fence is still sendable once the hold clears, so the refusal was the hold', async () => {
    // The control that keeps the test above honest: if the fence had been broken rather
    // than held, this would fail and the refusal would have meant something else.
    const workspaceId = world.alpha.workspace.workspaceId;
    const context = world.systemContext(workspaceId);
    await world.clearHolds(workspaceId);
    const fenceId = await world.prepare(world.alpha);
    const fence = await readFence(context, fenceId);
    const decision = await decideSend(context, fence!, world.sendDeps(world.alpha));
    expect(decision.ok).toBe(true);
  });
});
