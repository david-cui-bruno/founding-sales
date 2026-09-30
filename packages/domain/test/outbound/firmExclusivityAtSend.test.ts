import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { databaseNow } from '../../policy/clock.ts';
import { CHANNEL_ACTION_KINDS, followUpPermissionSource } from '../../sequences/eligibility.ts';
import { readEnrollment, readStepExecution } from '../../sequences/rows.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import {
  openExtraSession,
  prepareFor,
  seedFirm,
  waitUntilBlocked,
  type ExtraSession,
} from './support/dispatchFixtures.ts';
import { withTransaction } from '../../db/queryable.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';

/**
 * One active prospecting contact per firm, enforced immediately before the send
 * (migration 0025; David, 29 September 2026, item 2).
 *
 * > "Enforce the rule at enrollment and immediately before sending, **including
 * > concurrent-worker behavior**."
 *
 * `enrollContact` refuses the second prospecting enrollment at a firm
 * (`test/sequences/scenarios.test.ts`, scenario 33), and that half stops the state from
 * being created from today. It does nothing about the rows that already exist: the
 * schema deliberately permitted two people at one firm until this migration, and
 * `docs/greenfield/sequences.md` said so. This file is about those rows.
 *
 * Both enrollments here are written by the step-execution fixture with
 * `originKind: 'prospecting'`, which is the pre-0025 population's shape, and both have a
 * prepared fence. The claim is where the rule is asked again, under the firm's row lock
 * and inside the claim's own transaction — so two workers dispatching the two fences at
 * the same instant serialise on the firm row, and exactly one e-mail reaches Gmail.
 *
 * ## The vacuous-pass trap
 *
 * A refusal proves nothing if neither fence could have gone. The single-fence control
 * at the top dispatches one prospecting fence at a firm of its own and requires `sent`,
 * so the world is demonstrably sendable before either race is run.
 */

let world: OutboundWorld;
let second: ExtraSession;
/** The barrier that makes the overlap a fact, and one racer beside `second` (P1-4). */
let barrier: ExtraSession;
let racer: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  second = await openExtraSession(world);
  barrier = await openExtraSession(world);
  racer = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await second?.close();
  await barrier?.close();
  await racer?.close();
  await world?.stop();
});

afterEach(async () => {
  await second?.session.query('ROLLBACK');
  await barrier?.session.query('ROLLBACK');
  await racer?.session.query('ROLLBACK');
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());

/** A prospecting fence for one more contact at `firm`, as a pre-0025 row would be. */
async function prospectingFence(firm: Awaited<ReturnType<typeof seedFirm>>): Promise<string> {
  const stepExecutionId = await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    originKind: 'prospecting',
  });
  return await prepareFor(world, world.alpha, firm, { stepExecutionId });
}

async function dispatch(fenceId: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

describe('a single_email permission is spent by the claim that sends it', () => {
  it('sends once, records consumption, and then refuses follow_up_scope_exhausted', async () => {
    const firm = await seedFirm(world, world.alpha, 'one-email');
    const stepExecutionId = await makeStepExecution(world.database.session, {
      workspaceId: workspaceId(),
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
    });
    // The fixture grants an `agreed_sequence` permission, because most fixtures want a
    // scope a send does not spend. This case is about the scope that is spent, so the one
    // row is narrowed to it: one step, one e-mail, the approved template version the
    // permission now has to carry (P0-2), and no sequence version. The evidence moves with
    // it: since P0-1 the call log has to say *what* was agreed, so the log that supports
    // this permission records the same single e-mail and the same template bytes.
    const { rows: narrowed } = await world.database.session.query<{ id: string; call_log_id: string }>(
      `UPDATE follow_up_permissions p
          SET scope = 'single_email', sequence_version_id = NULL,
              template_version_id = $3, max_steps = 1
        FROM step_executions e
        JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
       WHERE p.workspace_id = $1 AND e.workspace_id = $1 AND e.id = $2 AND p.id = n.permission_id
       RETURNING p.id, p.call_log_id`,
      [workspaceId(), stepExecutionId, world.alpha.templateVersionId],
    );
    const permissionId = narrowed[0]?.id ?? '';
    expect(permissionId).not.toBe('');
    await world.database.session.query(
      `UPDATE call_logs
          SET agreed_follow_up = 'single_email', agreed_sequence_version_id = NULL,
              agreed_template_version_id = $3
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), narrowed[0]?.call_log_id ?? '', world.alpha.templateVersionId],
    );

    const fenceId = await prepareFor(world, world.alpha, firm, { stepExecutionId });
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, JSON.stringify(report)).toBe('sent');
    expect(sends).toBe(1);

    const { rows: after } = await world.database.session.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), permissionId],
    );
    expect(after[0]?.consumed_at).not.toBeNull();

    // And the step it paid for is now refused by the source, with the code an operator
    // reads: there is nothing to clear, only a new permission to grant.
    const execution = await readStepExecution(context(), stepExecutionId);
    if (execution === null) throw new Error('the step execution disappeared');
    const enrollment = await readEnrollment(context(), { enrollmentId: execution.enrollmentId });
    if (enrollment === null) throw new Error('the enrollment disappeared');
    const outcome = await followUpPermissionSource().evaluate(context(), {
      execution,
      opportunityId: enrollment.opportunityId,
      firmId: enrollment.firmId,
      contactId: enrollment.contactId,
      ownerUserId: enrollment.assignedUserId,
      channel: execution.channel,
      actionKind: CHANNEL_ACTION_KINDS[execution.channel],
      now: await databaseNow(context()),
    });
    expect(outcome).toEqual({
      ok: false,
      reasonCode: 'follow_up_scope_exhausted',
      detail: 'already_sent',
    });
  });
});

describe('the firm rule at the dispatch claim', () => {
  it('sends the one prospecting fence of a firm that has only one', async () => {
    const firm = await seedFirm(world, world.alpha, 'solo');
    const { report, sends } = await dispatch(await prospectingFence(firm));
    expect(report.outcome, JSON.stringify(report)).toBe('sent');
    expect(sends).toBe(1);
  });

  it('refuses the later of two live prospecting enrollments at one firm', async () => {
    const firm = await seedFirm(world, world.alpha, 'pair');
    const earlier = await prospectingFence(firm);
    const later = await prospectingFence(firm);

    const first = await dispatch(earlier);
    expect(first.report.outcome, JSON.stringify(first.report)).toBe('sent');

    const refused = await dispatch(later);
    expect(refused.report.outcome).toBe('held');
    expect(refused.report.refusal).toBe('step_ineligible');
    expect(refused.report.detail ?? '').toContain('firm_already_enrolled');
    // Nothing reached Gmail on the second attempt.
    expect(refused.sends).toBe(0);
  });

  it('two claim transactions that are provably open at once send exactly one e-mail', async () => {
    // P1-4 of the GPT-6 review of PR 332: the old version of this case launched both
    // dispatches together and asserted the outcome, which a serial pair would satisfy
    // too. The barrier is a third connection holding the firm row: both claims reach it
    // *inside their own transactions* — each has already taken the send gate and its own
    // fence — and `pg_locks` says so before the barrier is released. So the overlap is a
    // fact of the test rather than a hope about the scheduler.
    const firm = await seedFirm(world, world.alpha, 'barrier');
    const earlier = await prospectingFence(firm);
    const later = await prospectingFence(firm);

    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT id FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId(),
      firm.firmId,
    ]);

    const gmailFirst = world.clientWith(world.alpha, {});
    const gmailSecond = world.clientWith(world.alpha, {});
    const first = dispatchOutboundMessage(racer.context(workspaceId()), world.sendDeps(world.alpha, { gmail: gmailFirst }), {
      outboundMessageId: earlier,
    });
    const secondRun = dispatchOutboundMessage(second.context(workspaceId()), world.sendDeps(world.alpha, { gmail: gmailSecond }), {
      outboundMessageId: later,
    });

    // Both are waiting on the firm row, both inside a transaction of their own.
    await waitUntilBlocked(world.database.session, racer.pid);
    await waitUntilBlocked(world.database.session, second.pid);
    const { rows: open } = await world.database.session.query<{ count: string }>(
      `SELECT count(*) AS count FROM pg_stat_activity
        WHERE pid = ANY($1::int[]) AND state = 'idle in transaction' OR pid = ANY($1::int[]) AND state = 'active'`,
      [[racer.pid, second.pid]],
    );
    expect(Number(open[0]?.count ?? '0')).toBe(2);

    await barrier.session.query('COMMIT');
    const reports = await Promise.all([first, secondRun]);

    const sent = reports.filter(report => report.outcome === 'sent');
    expect(sent.length, JSON.stringify(reports)).toBe(1);
    expect(gmailFirst.sends.length + gmailSecond.sends.length).toBe(1);
    const held = reports.find(report => report.outcome !== 'sent');
    expect(`${held?.refusal ?? ''}:${held?.detail ?? ''}`).toContain('firm_already_enrolled');
  });

  it('breaks a tie in started_at by id, so two enrollments of the same instant still pick one winner', async () => {
    // P1-4: the winner query orders by `(started_at, id)`, and the case that proved it
    // used two distinct instants, which the ordering would satisfy without the tiebreak.
    const firm = await seedFirm(world, world.alpha, 'tie');
    const earlier = await prospectingFence(firm);
    const later = await prospectingFence(firm);
    await world.database.session.query(
      `UPDATE sequence_enrollments SET started_at = now()
        WHERE workspace_id = $1 AND firm_id = $2 AND ended_at IS NULL`,
      [workspaceId(), firm.firmId],
    );
    const { rows: tied } = await world.database.session.query<{ instants: string }>(
      `SELECT count(DISTINCT started_at)::text AS instants FROM sequence_enrollments
        WHERE workspace_id = $1 AND firm_id = $2 AND ended_at IS NULL`,
      [workspaceId(), firm.firmId],
    );
    expect(tied[0]?.instants).toBe('1');

    const first = await dispatch(earlier);
    const second_ = await dispatch(later);
    const outcomes = [first, second_];
    expect(outcomes.filter(run => run.report.outcome === 'sent')).toHaveLength(1);
    expect(first.sends + second_.sends).toBe(1);
    const refused = outcomes.find(run => run.report.outcome !== 'sent');
    expect(`${refused?.report.refusal ?? ''}:${refused?.report.detail ?? ''}`).toContain('firm_already_enrolled');
  });

  it('a real claim and a real call outcome overlap without deadlocking', async () => {
    // P1-4, as the second review asked for it: not a hand-made lock sequence with its
    // errors swallowed, but the two real commands, forced to overlap, with the deadlock
    // SQLSTATE asserted absent on both sides.
    //
    // The order is the whole argument. Every stop-fact writer — `logCallOutcome`
    // included, since the second review — takes the send gate EXCLUSIVE before any row;
    // every claim takes it SHARED before any row. So the call waits at the gate while the
    // claim holds it, and the claim waits for the firm the barrier holds; when the
    // barrier lets go, the claim finishes, drops the gate, and the call proceeds. No
    // cycle exists to detect.
    const firm = await seedFirm(world, world.alpha, 'deadlock');
    const fenceId = await prospectingFence(firm);
    const { rows: contacts } = await world.database.session.query<{ id: string }>(
      'SELECT contact_id AS id FROM sequence_enrollments WHERE workspace_id = $1 AND firm_id = $2 LIMIT 1',
      [workspaceId(), firm.firmId],
    );

    // The barrier holds the **fence**, not the firm: that is the row the claim locks
    // *after* it has taken the gate, so the claim ends up holding the gate and waiting —
    // which is the state this whole argument is about. (A barrier on the firm row catches
    // the dispatch in its precheck instead, before the gate, and proves nothing.)
    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT id FROM outbound_messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId(),
      fenceId,
    ]);

    const gmail = world.clientWith(world.alpha, {});
    const claim = dispatchOutboundMessage(racer.context(workspaceId()), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    await waitUntilBlocked(world.database.session, racer.pid);

    // The call outcome, on its own connection, as `runPolicyCommand` runs it: one
    // transaction, the real command, and an **engaged** outcome — which is the only kind
    // that reaches the stop the old code took the gate for. A `no_answer` never gets
    // there, so a test that logged one passed whether or not the gate came first (the
    // third review of PR 332).
    const caller = repositoryContext(
      workspaceScope(workspaceId(), {
        kind: 'user',
        userId: world.alpha.workspace.salesperson.userId,
        role: 'salesperson',
      }),
      second.session,
    );
    const call = withTransaction(second.session as Parameters<typeof withTransaction>[0], async () =>
      await logCallOutcome(caller, {
        firmId: firm.firmId,
        ...(contacts[0]?.id === undefined ? {} : { contactId: contacts[0].id }),
        outcome: 'interested',
      }),
    );

    // The call is queued behind the claim: the claim holds the gate SHARED for the whole
    // of its transaction, so the call's EXCLUSIVE request waits. Take the gate away from
    // the front of the call — the order this lane changed — and the call takes the firm
    // row first and *then* asks for the gate, while the claim, released by the barrier,
    // asks for that firm row inside `firmExclusivitySource`. Each holds what the other
    // needs, which is the cycle PostgreSQL breaks with `40P01`.
    await waitUntilBlocked(world.database.session, second.pid);
    await barrier.session.query('COMMIT');
    // Neither side is aborted. `40P01` is PostgreSQL's deadlock, and a failure of the
    // ordering above would raise it on one of these two.
    const report = await claim.catch((error: unknown) => error);
    const logged = await call.catch((error: unknown) => error);
    for (const [name, result] of [['the claim', report], ['the call outcome', logged]] as const) {
      const code = (result as { code?: unknown })?.code;
      expect(code, `${name} was aborted: ${String((result as { message?: string })?.message ?? '')}`).not.toBe('40P01');
      expect(result, `${name} threw`).not.toBeInstanceOf(Error);
    }
    expect((report as SendReport).outcome, JSON.stringify(report)).toBe('sent');
    expect((logged as { ok: boolean }).ok, JSON.stringify(logged)).toBe(true);
  });

  it('two concurrent claims at one firm send exactly one e-mail', async () => {
    const firm = await seedFirm(world, world.alpha, 'race');
    const earlier = await prospectingFence(firm);
    const later = await prospectingFence(firm);

    // Two workers, two connections, one instant. Each opens its own claim transaction,
    // and the firm row is the serialisation point: whichever reaches it second waits and
    // then reads what the first committed.
    const gmailFirst = world.clientWith(world.alpha, {});
    const gmailSecond = world.clientWith(world.alpha, {});
    const reports = await Promise.all([
      dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail: gmailFirst }), {
        outboundMessageId: earlier,
      }),
      dispatchOutboundMessage(second.context(workspaceId()), world.sendDeps(world.alpha, { gmail: gmailSecond }), {
        outboundMessageId: later,
      }),
    ]);

    const sent = reports.filter(report => report.outcome === 'sent');
    expect(sent.length, JSON.stringify(reports)).toBe(1);
    expect(gmailFirst.sends.length + gmailSecond.sends.length).toBe(1);
    // And the one that did not go says why, rather than failing for a reason of its own.
    const held = reports.find(report => report.outcome !== 'sent');
    expect(held?.outcome).toBe('held');
    expect(`${held?.refusal ?? ''}:${held?.detail ?? ''}`).toContain('firm_already_enrolled');
  });
});
