import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { setManualControlMode } from '../../crm/pipeline.ts';
import { runMailSync } from '../../mail/index.ts';
import {
  claimedAutomatedSends,
  dispatchOutboundMessage,
  readFence,
  type SendReport,
} from '../../outbound/index.ts';
import { lockSendGateForDispatch, openHold } from '../../policy/index.ts';
import { applyManualModeStop } from '../../sequences/terminalStops.ts';
import { recordSuppression } from '../../suppression/index.ts';
import { fixtureMessage } from '../mail/support/mailWorld.ts';
import {
  FIXTURE_BUSINESS_DATE,
  createOutboundWorld,
  type OutboundWorld,
} from './support/outboundWorld.ts';
import {
  automatedSent,
  backendPid,
  openExtraSession,
  pausingAtTokenRefresh,
  prepareFor,
  seedFirm,
  settle,
  tracked,
  waitUntilBlocked,
  waitUntilSleeping,
  type ExtraSession,
  type SeededFirm,
} from './support/dispatchFixtures.ts';

/**
 * Appendix G 3 and 6 with the race window actually entered (lane g77: S01, T02, C25).
 *
 * Appendix G 3: "Worker pauses after eligibility read, reply commits, worker resumes: no
 * external action after the reply linearizes." The release check that stood for it
 * (`test/release/scenario03.check.ts` before this lane) committed the reply *before*
 * calling the dispatch, so the dispatch simply read it. The window the audit found —
 * the gate reads, the counter moves, OAuth runs, a state-only UPDATE claims — was never
 * entered, and a reply that committed during the OAuth call was never re-read.
 *
 * Here the reply commits *inside* the dispatch: during the token refresh, on another
 * connection, after the precheck has read the world and found it sendable. The token
 * refresh is a real step of the real path (step 3 of `send.ts`), so the pause needs no
 * hook in the product. Three replies, because 7.3 and 12.4 give a reply three shapes:
 * the uncertain one the mail pipeline holds, the confirmed one that sets the
 * opportunity manual and ends its enrollments, and the opt-out.
 *
 * Then the other half, which a pause *before* the claim cannot show: the send gate
 * really does serialize. A reply whose transaction is open when the claim begins makes
 * the claim wait for it and then read it; a claim whose transaction is open when a
 * reply begins makes the reply wait until the claim has committed. `pg_locks` says
 * which side is waiting for which.
 *
 * And the capacity each attempt reserves (C25): counted in the claim's transaction or
 * not at all, including when the process dies between the reservation and the commit.
 *
 * ## The vacuous-pass traps
 *
 * A refusal proves nothing if the world could never send. Every race here asserts the
 * pause happened (the token refresh ran, so the precheck passed), and a control
 * dispatches the same shape with a pause that commits nothing and requires `sent`. A
 * refusal for the wrong reason would pass a looser assertion too, so each names the
 * reason: `step_ineligible` with the reply's own section 15 code, or the suppression.
 */

let world: OutboundWorld;
let second: ExtraSession;
let third: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  second = await openExtraSession(world);
  third = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await second?.close();
  await third?.close();
  await world?.stop();
});

// A test that fails between its BEGIN and its COMMIT must not leave the next test
// waiting on a lock it never released. ROLLBACK outside a transaction only warns.
afterEach(async () => {
  await second?.session.query('ROLLBACK');
  await third?.session.query('ROLLBACK');
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());
const sendsOf = (gmail: { readonly sends: readonly unknown[] }): number => gmail.sends.length;

/** The day's counter and the fences behind it, which must always agree. */
async function capacity(): Promise<{ readonly counter: number; readonly claimed: number }> {
  return {
    counter: await automatedSent(world.database.session, world.alpha, FIXTURE_BUSINESS_DATE),
    claimed: await claimedAutomatedSends(context(), {
      mailboxId: world.alpha.mailboxId,
      businessDate: FIXTURE_BUSINESS_DATE,
    }),
  };
}

/** Dispatch one fence with a pause at the token refresh; the pause runs `during`. */
async function dispatchPausing(
  fenceId: string,
  during: () => Promise<void>,
): Promise<{ readonly report: SendReport; readonly sends: number; readonly refreshes: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const paused = pausingAtTokenRefresh(gmail, during);
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail: paused.client }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: sendsOf(gmail), refreshes: paused.refreshes() };
}

/** An inbound reply from the firm's prospect, through the real mail sync, on `session`. */
async function commitInboundReply(session: ExtraSession, firm: SeededFirm, id: string): Promise<void> {
  const { rows } = await session.session.query<{ history_id: string }>(
    'SELECT history_id FROM mailboxes WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), world.alpha.mailboxId],
  );
  const next = String(BigInt(rows[0]?.history_id ?? '1000') + 10n);
  const reply = fixtureMessage({
    id,
    historyId: next,
    from: firm.address,
    to: world.alpha.address,
    body: 'Thanks for the note. Could we talk about this next week?',
    // Now, so the sync's watermark stays fresh: the refusal this test wants is the
    // reply's hold, and a stale-coverage refusal would pass it for the wrong reason.
    internalDateEpochMilliseconds: Date.now(),
  });
  const gmail = world.clientWith(world.alpha, { messages: [reply], historyId: next });
  const report = await withTransaction(
    session.session,
    async () =>
      await runMailSync(session.context(workspaceId()), world.syncDeps(world.alpha, { gmail }), {
        mailboxId: world.alpha.mailboxId,
      }),
  );
  expect(report.outcome, 'the reply must have been read and applied').toBe('synced');
}

describe('Appendix G 3: a reply commits while the dispatch is between its read and its claim', () => {
  it('the control: a pause that commits nothing still sends, so the pause is not the refusal', async () => {
    const firm = await seedFirm(world, world.alpha, 'control');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const before = await capacity();

    const { report, sends, refreshes } = await dispatchPausing(fenceId, async () => {
      await Promise.resolve();
    });
    expect(refreshes).toBe(1);
    expect(report.outcome, `${report.refusal ?? ''} ${report.detail ?? ''}`).toBe('sent');
    expect(sends).toBe(1);

    const after = await capacity();
    expect(after.counter).toBe(before.counter + 1);
    expect(after.claimed).toBe(after.counter);
  });

  it('an uncertain reply read by the mail sync on another connection stops the send', async () => {
    const firm = await seedFirm(world, world.alpha, 'uncertain');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const before = await capacity();

    const { report, sends, refreshes } = await dispatchPausing(fenceId, async () => {
      await commitInboundReply(second, firm, 'g77-reply-uncertain');
    });

    // The pause happened after the precheck passed: OAuth runs only on a sendable fence.
    expect(refreshes).toBe(1);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail ?? '').toMatch(/^uncertain_reply/);
    expect(sends).toBe(0);
    expect((await readFence(context(), fenceId))?.state).toBe('held');

    // C25: the refused attempt reserved nothing.
    const after = await capacity();
    expect(after.counter).toBe(before.counter);
    expect(after.claimed).toBe(after.counter);
  });

  it('a confirmed human reply — manual mode and the terminal stop — stops the send', async () => {
    const firm = await seedFirm(world, world.alpha, 'confirmed');
    const fenceId = await prepareFor(world, world.alpha, firm);

    const { report, sends, refreshes } = await dispatchPausing(fenceId, async () => {
      // 7.3's one transaction, as `confirmReplyDisposition` commits it.
      await withTransaction(second.session, async () => {
        const worker = second.context(workspaceId());
        const manual = await setManualControlMode(worker, {
          opportunityId: firm.opportunityId,
          reason: 'confirmed human reply',
          origin: 'human_reply',
        });
        expect(manual.ok).toBe(true);
        await applyManualModeStop(worker, { firmId: firm.firmId, origin: 'human_reply' });
      });
    });

    expect(refreshes).toBe(1);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    // Control mode is asked before the enrollment, so manual mode is the reason named.
    expect(report.detail ?? '').toMatch(/^opportunity_manual/);
    expect(sends).toBe(0);
  });

  it('Appendix G 6: an opt-out committed on another connection stops the send', async () => {
    const firm = await seedFirm(world, world.alpha, 'optout');
    const fenceId = await prepareFor(world, world.alpha, firm);

    const { report, sends, refreshes } = await dispatchPausing(fenceId, async () => {
      await withTransaction(second.session, async () => {
        const recorded = await recordSuppression(second.context(workspaceId()), {
          scope: 'handle',
          value: firm.address,
          source: 'prospect_opt_out',
          journal: world.journal,
        });
        expect(recorded.ok).toBe(true);
      });
    });

    expect(refreshes).toBe(1);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('handle_suppressed');
    expect(sends).toBe(0);
  });
});

describe('the send gate serializes the claim with every stop fact', () => {
  it('a reply whose transaction is open makes the claim wait, and the claim then reads it', async () => {
    const firm = await seedFirm(world, world.alpha, 'writer-first');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const mainPid = await backendPid(world.database.session);

    // The reply's transaction: its hold is written and the gate is held, uncommitted.
    await second.session.query('BEGIN');
    await openHold(second.context(workspaceId()), {
      scopeKind: 'opportunity',
      scopeKey: firm.opportunityId,
      reasonCode: 'uncertain_reply',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'mail_message',
      recoveryAction: 'confirm_reply',
    });

    const gmail = world.clientWith(world.alpha, {});
    const dispatch = tracked(
      dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: fenceId }),
    );
    // The claim is waiting on the send gate — not finished, and nothing sent.
    await waitUntilBlocked(third.session, mainPid, 'advisory');
    await settle(100);
    expect(dispatch.settled()).toBe(false);
    expect(sendsOf(gmail)).toBe(0);

    await second.session.query('COMMIT');
    const report = await dispatch.promise;
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail ?? '').toMatch(/^uncertain_reply/);
    expect(sendsOf(gmail)).toBe(0);
  });

  it('a claim whose transaction is open makes the reply wait until the claim has committed', async () => {
    const firm = await seedFirm(world, world.alpha, 'claim-first');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const fence = await readFence(context(), fenceId);
    const mainPid = await backendPid(world.database.session);

    // Hold the claim inside its transaction: the enrollment's row is locked here
    // without the gate, so the claim takes the gate and the fence, then waits.
    await second.session.query('BEGIN');
    await second.session.query(
      `SELECT n.id FROM sequence_enrollments n
         JOIN step_executions e ON e.workspace_id = n.workspace_id AND e.enrollment_id = n.id
        WHERE e.workspace_id = $1 AND e.id = $2 FOR UPDATE OF n`,
      [workspaceId(), fence?.stepExecutionId],
    );

    const gmail = world.clientWith(world.alpha, {});
    const dispatch = tracked(
      dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), { outboundMessageId: fenceId }),
    );
    await waitUntilBlocked(third.session, mainPid);

    // Now the reply, on a third connection. It must wait for the claim: its hold
    // cannot commit between the claim's recheck and its commit.
    const reply = tracked(
      withTransaction(third.session, async () => {
        await openHold(third.context(workspaceId()), {
          scopeKind: 'opportunity',
          scopeKey: firm.opportunityId,
          reasonCode: 'uncertain_reply',
          blockedActionKinds: ['email_send', 'enrollment_advance'],
          sourceEventKind: 'mail_message',
          recoveryAction: 'confirm_reply',
        });
      }),
    );
    await waitUntilBlocked(second.session, third.pid, 'advisory');
    await settle(100);
    expect(reply.settled()).toBe(false);

    // Release the claim. It commits first, so its send linearizes before the reply.
    await second.session.query('COMMIT');
    const report = await dispatch.promise;
    await reply.promise;
    expect(report.outcome, `${report.refusal ?? ''} ${report.detail ?? ''}`).toBe('sent');
    expect(sendsOf(gmail)).toBe(1);

    // And the reply, committed after the claim, stops everything after it.
    const later = await prepareFor(world, world.alpha, firm);
    const refused = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: later,
    });
    expect(refused.outcome).toBe('held');
    expect(refused.detail ?? '').toMatch(/^uncertain_reply/);
    expect(sendsOf(gmail)).toBe(1);
  });

  it('two claims share the gate and do not wait for each other', async () => {
    await second.session.query('BEGIN');
    await lockSendGateForDispatch(second.context(workspaceId()));
    const firm = await seedFirm(world, world.alpha, 'shared');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const gmail = world.clientWith(world.alpha, {});
    const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    await second.session.query('COMMIT');
    expect(report.outcome).toBe('sent');
  });
});

describe('C25: capacity is reserved by the claim and nowhere else', () => {
  it('a grant that fails at the token refresh reserves nothing', async () => {
    const firm = await seedFirm(world, world.alpha, 'revoked');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const before = await capacity();
    const gmail = world.clientWith(world.alpha, { grantRevoked: true });
    const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('grant_revoked');
    const after = await capacity();
    expect(after.counter).toBe(before.counter);
    expect(after.claimed).toBe(after.counter);
    await world.clearHolds(workspaceId());
  });

  it('a process that dies between the reservation and the commit leaves no count behind', async () => {
    const firm = await seedFirm(world, world.alpha, 'crash');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const before = await capacity();
    const session = world.database.session;

    // The claim's UPDATE sleeps for this fence only — after the reservation's UPDATE
    // in the same transaction — so the backend can be killed in exactly that gap.
    await session.query(`
      CREATE FUNCTION g77_pause_the_claim() RETURNS trigger LANGUAGE plpgsql AS $pause$
      BEGIN
        IF NEW.id = '${fenceId}'::uuid AND NEW.state = 'dispatching' AND OLD.state = 'prepared' THEN
          PERFORM pg_sleep(30);
        END IF;
        RETURN NEW;
      END;
      $pause$`);
    await session.query(
      'CREATE TRIGGER zz_g77_pause_the_claim BEFORE UPDATE ON outbound_messages FOR EACH ROW EXECUTE FUNCTION g77_pause_the_claim()',
    );
    const dying = await openExtraSession(world);
    const gmail = world.clientWith(world.alpha, {});
    try {
      const dispatch = tracked(
        dispatchOutboundMessage(dying.context(workspaceId()), world.sendDeps(world.alpha, { gmail }), {
          outboundMessageId: fenceId,
        }),
      );
      await waitUntilSleeping(session, dying.pid);
      await session.query('SELECT pg_terminate_backend($1)', [dying.pid]);
      await expect(dispatch.promise).rejects.toThrow();
    } finally {
      await dying.close();
      await session.query('DROP TRIGGER zz_g77_pause_the_claim ON outbound_messages');
      await session.query('DROP FUNCTION g77_pause_the_claim()');
    }

    // Nothing claimed, nothing sent, nothing counted.
    expect((await readFence(context(), fenceId))?.state).toBe('prepared');
    expect(sendsOf(gmail)).toBe(0);
    const orphaned = await capacity();
    expect(orphaned.counter).toBe(before.counter);
    expect(orphaned.claimed).toBe(orphaned.counter);

    // The fence is still sendable, and sending it counts it once.
    const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    expect(report.outcome).toBe('sent');
    expect(sendsOf(gmail)).toBe(1);
    const after = await capacity();
    expect(after.counter).toBe(before.counter + 1);
    expect(after.claimed).toBe(after.counter);
  });

  it('refuses to run inside a caller’s transaction, before anything is claimed', async () => {
    const firm = await seedFirm(world, world.alpha, 'nested');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const gmail = world.clientWith(world.alpha, {});
    await expect(
      withTransaction(
        world.database.session,
        async () =>
          await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
            outboundMessageId: fenceId,
          }),
      ),
    ).rejects.toThrow(/outside any transaction/);
    expect(sendsOf(gmail)).toBe(0);
    expect((await readFence(context(), fenceId))?.state).toBe('prepared');
  });
});
