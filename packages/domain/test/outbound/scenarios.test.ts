import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordSuppression } from '../../suppression/events.ts';
import {
  claimForDispatch,
  readFence,
  readFenceEvents,
  readOutboundOutcome,
  resolveUnknownTerminal,
} from '../../outbound/fence.ts';
import { setAdminCap } from '../../outbound/ramp.ts';
import { listMailboxesToReconcile, reconcileOutboundMessage } from '../../outbound/reconcile.ts';
import { outboundRecoveryFloor } from '../../outbound/recoveryFloor.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import {
  CLOSED_INSTANT,
  FIXTURE_BUSINESS_DATE,
  createOutboundWorld,
  type OutboundWorld,
} from './support/outboundWorld.ts';

/**
 * The at-most-once send, against a real PostgreSQL (Appendix G 5, 12, 16, 33 and 36).
 *
 * Every scenario here is one of two questions: *was the message sent exactly once*,
 * and *was it not sent when it should not have been*. The recorded Gmail client
 * answers the first — `gmail.sends` is a list, and its length is the assertion —
 * and the database answers the second.
 *
 * Nothing in this file opens a socket.
 */
describe('at-most-once sending', () => {
  let world: OutboundWorld;

  beforeAll(async () => {
    world = await createOutboundWorld();
  });

  afterAll(async () => {
    await world.stop();
  });

  const context = () => world.systemContext(world.alpha.workspace.workspaceId);

  // ------------------------------------------------------------ the happy path
  it('sends once, records the provider ids and leaves a complete ledger', async () => {
    const fenceId = await world.prepare(world.alpha);
    const deps = world.sendDeps(world.alpha);
    const report = await dispatchOutboundMessage(context(), deps, { outboundMessageId: fenceId });

    expect(report.outcome).toBe('sent');
    const fence = await readFence(context(), fenceId);
    expect(fence?.state).toBe('sent');
    expect(fence?.providerMessageId).not.toBeNull();
    expect(fence?.sentAt).not.toBeNull();

    // The header FSS wrote is the one Gmail was asked to use, which is what makes a
    // later Sent-folder search possible at all.
    const sends = world.alpha.gmail.sends;
    expect(sends).toHaveLength(1);
    expect(sends[0]?.rfcMessageId).toBe(fence?.providerMessageIdHeader);
    expect(sends[0]?.to).toBe(world.alpha.recipientAddress);
    // 12.7: no open-tracking pixel, and 12.6: no unsubscribe link.
    expect(sends[0]?.body).not.toMatch(/unsubscribe/i);
    expect(sends[0]?.body).toContain('Reply "stop"');

    const events = await readFenceEvents(context(), fenceId);
    expect(events.map(event => event.toState)).toEqual(['prepared', 'dispatching', 'sent']);
  });

  it('refuses to dispatch the same fence twice, and Gmail is called once', async () => {
    const fenceId = await world.prepare(world.alpha);
    const deps = world.sendDeps(world.alpha);
    const before = world.alpha.gmail.sends.length;

    const first = await dispatchOutboundMessage(context(), deps, { outboundMessageId: fenceId });
    const second = await dispatchOutboundMessage(context(), deps, { outboundMessageId: fenceId });

    expect(first.outcome).toBe('sent');
    expect(second.outcome).toBe('already_terminal');
    expect(world.alpha.gmail.sends.length - before).toBe(1);
  });

  it('reuses the one fence for a step execution rather than making a second', async () => {
    const stepExecutionId = '00000000-0000-4000-9000-0000000000aa';
    const first = await world.prepare(world.alpha, { stepExecutionId });
    const second = await world.prepare(world.alpha, { stepExecutionId });
    expect(second).toBe(first);

    const outcome = await readOutboundOutcome(context(), stepExecutionId);
    expect(outcome.state).toBe('prepared');
    expect(outcome.outboundMessageId).toBe(first);
  });

  it('reports absent for a step execution that has no fence', async () => {
    const outcome = await readOutboundOutcome(context(), '00000000-0000-4000-9000-0000000000bb');
    expect(outcome.state).toBe('absent');
    expect(outcome.outboundMessageId).toBeNull();
  });

  // ------------------------------------------------- Appendix G 12: stolen lease
  it('Appendix G 12: a worker that lost the race cannot send, and the winner can', async () => {
    const fenceId = await world.prepare(world.alpha);

    // One worker claims. That is the atomic prepared → dispatching.
    const winner = await claimForDispatch(context(), { outboundMessageId: fenceId, actor: 'worker-a' });
    expect(winner.ok).toBe(true);

    // The replacement arrives and tries the whole dispatch path. It must not send.
    const before = world.alpha.gmail.sends.length;
    const replacement = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha), {
      outboundMessageId: fenceId,
    });
    expect(replacement.outcome).toBe('not_ready');
    expect(world.alpha.gmail.sends.length).toBe(before);

    // And it cannot claim either: the token is not reusable.
    const secondClaim = await claimForDispatch(context(), { outboundMessageId: fenceId, actor: 'worker-b' });
    expect(secondClaim.ok).toBe(false);
  });

  // ------------------------------------ Appendix G 5: dropped response, then found
  it('Appendix G 5: Gmail accepts and drops the response; the Sent search settles it', async () => {
    const gmail = world.clientWith(world.alpha, { sendBehaviour: 'indeterminate_but_delivered' });
    const fenceId = await world.prepare(world.alpha);

    const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(report.outcome).toBe('reconciling');
    expect(gmail.sends).toHaveLength(1);

    // While it is in doubt the firm is held, so no successor runs on a maybe.
    const held = await context().db.query<{ reason_code: string }>(
      `SELECT reason_code FROM active_holds
        WHERE workspace_id = $1 AND source_event_id = $2 AND released_at IS NULL`,
      [world.alpha.workspace.workspaceId, fenceId],
    );
    expect(held.rows.map(row => row.reason_code)).toContain('send_unknown_reconciling');

    // 12.7's third health condition: the dispatch that did not
    // answer `ok` is the only provider complaint FSS can observe, and the day it
    // happened on records it. Without this the ramp judged every day on nothing.
    const signalled = await context().db.query<{ provider_errors: number }>(
      `SELECT provider_errors FROM mailbox_send_days
        WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
      [world.alpha.workspace.workspaceId, world.alpha.mailboxId, FIXTURE_BUSINESS_DATE],
    );
    expect(signalled.rows[0]?.provider_errors).toBe(1);

    const settled = await reconcileOutboundMessage(context(), world.reconcileDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(settled.outcome).toBe('sent');

    const fence = await readFence(context(), fenceId);
    expect(fence?.state).toBe('sent');
    // Back-dated to dispatch, because 12.5 computes the successor from the original
    // dispatch time rather than from when we noticed.
    expect(fence?.sentAt).toBe(fence?.dispatchStartedAt);
    // Still exactly one send: reconciliation observes, it never sends.
    expect(gmail.sends).toHaveLength(1);

    const after = await context().db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM active_holds
        WHERE workspace_id = $1 AND source_event_id = $2 AND released_at IS NULL`,
      [world.alpha.workspace.workspaceId, fenceId],
    );
    expect(after.rows[0]?.count).toBe('0');
  });

  it('Appendix G 5: a Sent index that lags is observed again, not given up on', async () => {
    const gmail = world.clientWith(world.alpha, {
      sendBehaviour: 'indeterminate_but_delivered',
      sentIndexingDelay: 2,
    });
    const fenceId = await world.prepare(world.alpha);
    await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });

    const deps = world.reconcileDeps(world.alpha, { gmail });
    const first = await reconcileOutboundMessage(context(), deps, { outboundMessageId: fenceId });
    expect(first.outcome).toBe('still_unknown');
    expect(first.nextAttemptInSeconds).toBeGreaterThan(0);
    const second = await reconcileOutboundMessage(context(), deps, { outboundMessageId: fenceId });
    expect(second.outcome).toBe('still_unknown');
    const third = await reconcileOutboundMessage(context(), deps, { outboundMessageId: fenceId });
    expect(third.outcome).toBe('sent');
    expect(gmail.sends).toHaveLength(1);
  });

  // ------------------------------- Appendix G 5 and 36: permanent absence, no resend
  it('Appendix G 5 and 36: the observation expires into unknown_terminal and never resends', async () => {
    const gmail = world.clientWith(world.alpha, { sendBehaviour: 'indeterminate' });
    const fenceId = await world.prepare(world.alpha);
    await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });

    // Appendix B's window is 24 hours, and `markUnknownTerminal` compares it with the
    // *database* clock — an injected one cannot talk it into expiring early, which is
    // the point. So the deadline is moved into the past, which is what a day passing
    // looks like from the row's side.
    await context().db.query(
      `UPDATE outbound_messages
          SET reconcile_started_at = now() - interval '25 hours',
              reconcile_deadline_at = now() - interval '1 hour'
        WHERE workspace_id = $1 AND id = $2`,
      [world.alpha.workspace.workspaceId, fenceId],
    );
    const expired = await reconcileOutboundMessage(context(), world.reconcileDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(expired.outcome).toBe('unknown_terminal');

    const fence = await readFence(context(), fenceId);
    expect(fence?.state).toBe('unknown_terminal');
    expect(fence?.unknownTerminalAt).not.toBeNull();

    // An admin's answer changes no state, because both answers mean the same thing
    // about Gmail: nothing further will be sent for this fence.
    const resolved = await resolveUnknownTerminal(context(), {
      outboundMessageId: fenceId,
      resolution: 'delivered',
      adminUserId: world.alpha.workspace.admin.userId,
    });
    expect(resolved.ok).toBe(true);
    const after = await readFence(context(), fenceId);
    expect(after?.state).toBe('unknown_terminal');
    expect(after?.adminResolution).toBe('delivered');

    // And a dispatch attempt afterwards sends nothing at all.
    const before = gmail.sends.length;
    const retried = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(retried.outcome).toBe('already_terminal');
    expect(gmail.sends.length).toBe(before);

    // 12.5: the successor's delay is computed from the original dispatch time.
    const outcome = await readOutboundOutcome(context(), after?.stepExecutionId ?? '');
    expect(outcome.state).toBe('unknown_terminal');
    expect(outcome.dispatchedAt).toBe(after?.dispatchStartedAt);
    expect(outcome.adminResolution).toBe('delivered');
  });

  it('Appendix G 36: marked skipped is equally terminal', async () => {
    await world.clearHolds(world.alpha.workspace.workspaceId);
    const gmail = world.clientWith(world.alpha, { sendBehaviour: 'indeterminate' });
    const fenceId = await world.prepare(world.alpha, { toAddress: 'skipped.prospect@example.test' });
    const dispatched = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(dispatched.outcome, `${dispatched.refusal ?? ''}`).toBe('reconciling');
    await context().db.query(
      `UPDATE outbound_messages
          SET reconcile_started_at = now() - interval '25 hours',
              reconcile_deadline_at = now() - interval '1 hour'
        WHERE workspace_id = $1 AND id = $2`,
      [world.alpha.workspace.workspaceId, fenceId],
    );
    await reconcileOutboundMessage(context(), world.reconcileDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    const resolved = await resolveUnknownTerminal(context(), {
      outboundMessageId: fenceId,
      resolution: 'skipped',
      adminUserId: world.alpha.workspace.admin.userId,
    });
    expect(resolved.ok && resolved.value.adminResolution).toBe('skipped');

    // A second resolution is refused: the question is answered once.
    const again = await resolveUnknownTerminal(context(), {
      outboundMessageId: fenceId,
      resolution: 'delivered',
      adminUserId: world.alpha.workspace.admin.userId,
    });
    expect(again.ok).toBe(false);
  });

  it('adopts a fence abandoned in dispatching, and adopting is not sending', async () => {
    const fenceId = await world.prepare(world.alpha);
    await claimForDispatch(context(), { outboundMessageId: fenceId, actor: 'worker-that-died' });
    // The dispatch instant cannot be forged — the trigger writes it once — so the
    // sweep's patience is what moves instead. That is the honest knob: production
    // waits five minutes, and this waits none.
    const gmail = world.clientWith(world.alpha, {});
    const adopted = await reconcileOutboundMessage(
      context(),
      world.reconcileDeps(world.alpha, { gmail, adoptAfterSeconds: 0 }),
      { outboundMessageId: fenceId },
    );
    expect(adopted.outcome).toBe('adopted');
    expect(gmail.sends).toHaveLength(0);

    const mailboxes = await listMailboxesToReconcile(world.database.session);
    expect(mailboxes.some(entry => entry.mailboxId === world.alpha.mailboxId)).toBe(true);
  });

  it('does not adopt a fence that was claimed a moment ago', async () => {
    const fenceId = await world.prepare(world.alpha);
    await claimForDispatch(context(), { outboundMessageId: fenceId, actor: 'worker-still-working' });
    const report = await reconcileOutboundMessage(context(), world.reconcileDeps(world.alpha), {
      outboundMessageId: fenceId,
    });
    expect(report.outcome).toBe('not_reconciling');
  });

  // ---------------------------------------------- Appendix G 33: the daily cap
  it('Appendix G 33: the mailbox cap holds the excess rather than sending it', async () => {
    const ctx = context();
    // This scenario is about one refusal, so the holds the earlier ones opened —
    // each correct, each blocking `email_send` for the firm — are cleared first.
    await world.clearHolds(world.alpha.workspace.workspaceId);
    // A fresh mailbox is on day zero of the ramp, which 12.7 caps at five. Lower it
    // to one so the test is about the rule and not about sending five emails.
    const lowered = await setAdminCap(ctx, {
      mailboxId: world.alpha.mailboxId,
      adminUserId: world.alpha.workspace.admin.userId,
      lowerTo: 1,
    });
    expect(lowered.ok && lowered.effectiveCap).toBe(1);

    // Its own business date, so the earlier scenarios' sends are not this test's
    // counters. `cap_granted` never decreases, so the row is made here at one.
    //
    // The date is the *dispatch clock's* (S05): the cap counts on the
    // business date of the claim, not the one the placement planned, so the day this
    // test is about is chosen by the instant it dispatches at — Thursday 24 September,
    // 13:00 UTC, inside the fixture firm's window and on that date in the workspace's
    // business zone too.
    const today = '2026-09-24';
    await ctx.db.query(
      `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, cap_granted)
       VALUES ($1, $2, $3::date, 1) ON CONFLICT DO NOTHING`,
      [world.alpha.workspace.workspaceId, world.alpha.mailboxId, today],
    );

    const gmail = world.clientWith(world.alpha, {});
    const deps = world.sendDeps(world.alpha, { gmail, now: () => new Date('2026-09-24T13:00:00.000Z') });
    const first = await dispatchOutboundMessage(ctx, deps, {
      outboundMessageId: await world.prepare(world.alpha, {
        businessDate: today,
        toAddress: 'cap.one@example.test',
      }),
    });
    const secondFenceId = await world.prepare(world.alpha, {
      businessDate: today,
      toAddress: 'cap.two@example.test',
    });
    const second = await dispatchOutboundMessage(ctx, deps, { outboundMessageId: secondFenceId });

    expect(first.outcome, first.refusal ?? '').toBe('sent');
    expect(second.outcome).toBe('held');
    expect(second.refusal).toBe('daily_cap');
    expect(gmail.sends).toHaveLength(1);

    const fence = await readFence(ctx, secondFenceId);
    expect(fence?.state).toBe('held');
    expect(fence?.heldReason).toBe('daily_cap');

    const holds = await ctx.db.query<{ reason_code: string }>(
      `SELECT reason_code FROM active_holds
        WHERE workspace_id = $1 AND source_event_id = $2 AND released_at IS NULL`,
      [world.alpha.workspace.workspaceId, secondFenceId],
    );
    expect(holds.rows.map(row => row.reason_code)).toContain('daily_cap');

    // Tomorrow's cap releases it: a held fence is re-preparable because it provably
    // never reached Gmail.
    await setAdminCap(ctx, {
      mailboxId: world.alpha.mailboxId,
      adminUserId: world.alpha.workspace.admin.userId,
      lowerTo: null,
    });
    await ctx.db.query(
      `UPDATE mailbox_send_days SET cap_granted = 5
        WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
      [world.alpha.workspace.workspaceId, world.alpha.mailboxId, today],
    );
    const released = await dispatchOutboundMessage(ctx, deps, { outboundMessageId: secondFenceId });
    expect(released.outcome).toBe('sent');
    expect(gmail.sends).toHaveLength(2);
  });

  // --------------------------------------------- Appendix G 6: opt-out linearizes
  it('Appendix G 6: an opt-out that commits before dispatch stops the send', async () => {
    const ctx = context();
    // This scenario is about one refusal, so the holds the earlier ones opened —
    // each correct, each blocking `email_send` for the firm — are cleared first.
    await world.clearHolds(world.alpha.workspace.workspaceId);
    const fenceId = await world.prepare(world.alpha, { toAddress: 'opted.out@example.test' });
    const fence = await readFence(ctx, fenceId);

    await recordSuppression(ctx, {
      scope: 'handle',
      value: fence?.recipientAddress ?? '',
      source: 'prospect_opt_out',
      journal: world.journal,
    });

    const gmail = world.clientWith(world.alpha, {});
    const report = await dispatchOutboundMessage(ctx, world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('handle_suppressed');
    expect(gmail.sends).toHaveLength(0);
  });

  // --------------------------------------------------- 11.2: the sending window
  it('11.2: a fence outside the firm-local window is held, not sent', async () => {
    const ctx = context();
    // This scenario is about one refusal, so the holds the earlier ones opened —
    // each correct, each blocking `email_send` for the firm — are cleared first.
    await world.clearHolds(world.alpha.workspace.workspaceId);
    const fenceId = await world.prepare(world.alpha, { toAddress: 'window.prospect@example.test' });
    const gmail = world.clientWith(world.alpha, {});
    // The same fence, judged at 03:00 instead of 09:00. Nothing about the fence
    // changed; only the instant the gate asks about.
    const report = await dispatchOutboundMessage(
      ctx,
      world.sendDeps(world.alpha, { gmail, now: () => new Date(CLOSED_INSTANT) }),
      { outboundMessageId: fenceId },
    );
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('outside_email_window');
    expect(gmail.sends).toHaveLength(0);
  });

  // ---------------------------------------- 12.3: the recovery floor, implemented
  it('12.3: an unresolved fence is the mailbox recovery floor, and a settled one is not', async () => {
    const ctx = context();
    const floor = outboundRecoveryFloor();

    const settledOnly = await floor.oldestUnresolvedAt(ctx, world.alpha.mailboxId);
    const gmail = world.clientWith(world.alpha, { sendBehaviour: 'indeterminate' });
    const fenceId = await world.prepare(world.alpha);
    await dispatchOutboundMessage(ctx, world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });

    const withDoubt = await floor.oldestUnresolvedAt(ctx, world.alpha.mailboxId);
    expect(withDoubt).not.toBeNull();
    const fence = await readFence(ctx, fenceId);
    if (settledOnly === null) expect(withDoubt).toBe(fence?.dispatchStartedAt);

    // A mailbox in the other workspace has its own floor and never sees this one.
    const betaFloor = await floor.oldestUnresolvedAt(
      world.systemContext(world.beta.workspace.workspaceId),
      world.beta.mailboxId,
    );
    expect(betaFloor).toBeNull();
  });

  // --------------------------------------------- Appendix G 8: two workspaces
  it('Appendix G 8: two workspaces may carry the same step execution id', async () => {
    const stepExecutionId = '00000000-0000-4000-9000-0000000000cc';
    const alphaFence = await world.prepare(world.alpha, { stepExecutionId });
    const betaFence = await world.prepare(world.beta, { stepExecutionId });
    expect(betaFence).not.toBe(alphaFence);

    const alphaOutcome = await readOutboundOutcome(context(), stepExecutionId);
    const betaOutcome = await readOutboundOutcome(
      world.systemContext(world.beta.workspace.workspaceId),
      stepExecutionId,
    );
    expect(alphaOutcome.outboundMessageId).toBe(alphaFence);
    expect(betaOutcome.outboundMessageId).toBe(betaFence);
  });
});
