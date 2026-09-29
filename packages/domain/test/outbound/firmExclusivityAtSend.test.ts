import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { databaseNow } from '../../policy/clock.ts';
import { CHANNEL_ACTION_KINDS, followUpPermissionSource } from '../../sequences/eligibility.ts';
import { readEnrollment, readStepExecution } from '../../sequences/rows.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { openExtraSession, prepareFor, seedFirm, type ExtraSession } from './support/dispatchFixtures.ts';

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

beforeAll(async () => {
  world = await createOutboundWorld();
  second = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await second?.close();
  await world?.stop();
});

afterEach(async () => {
  await second?.session.query('ROLLBACK');
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
    // scope a send does not spend. This case is about the scope that is spent, so the
    // one row is narrowed to it: one step, one e-mail, and `sequence_id` goes with the
    // scope that required it.
    const { rows: narrowed } = await world.database.session.query<{ id: string }>(
      `UPDATE follow_up_permissions p
          SET scope = 'single_email', sequence_id = NULL
        FROM step_executions e
        JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
       WHERE p.workspace_id = $1 AND e.workspace_id = $1 AND e.id = $2 AND p.id = n.permission_id
       RETURNING p.id`,
      [workspaceId(), stepExecutionId],
    );
    const permissionId = narrowed[0]?.id ?? '';
    expect(permissionId).not.toBe('');

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
