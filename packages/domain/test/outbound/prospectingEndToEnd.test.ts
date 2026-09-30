import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { fixtureSequenceVersionId } from '../../db/testing/stepExecutions.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { prepareOutboundMessage, readOutboundOutcome } from '../../outbound/fence.ts';
import { holdReasonForRefusal } from '../../outbound/gate.ts';
import { dispatchOutboundMessage, type OutboundSendDeps } from '../../outbound/send.ts';
import { composeEligibility } from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { dispatchPreparedStep, runDueStepExecution } from '../../sequences/executions.ts';
import { listStepExecutions } from '../../sequences/rows.ts';
import type { SendHandoff, SendHandoffRefusal } from '../../sequences/sendHandoff.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { seedFirm } from './support/dispatchFixtures.ts';

/**
 * A cold first touch, end to end: the command a person gives, the step the scheduler
 * wakes, the claim that really claims, and one e-mail at a fake Gmail
 * (P2-2 of the GPT-6 review of PR 332).
 *
 * Migration 0025 made every enrollment say what it is for, and the shared step-execution
 * fixture chose `follow_up` for the reason its header gives. That left the repository
 * with no test of the *other* origin along the whole path: scenario 33 asks the command
 * and the source separately, and the send tests start from a fence somebody inserted. A
 * regression that refused every prospecting enrollment at the claim — or one that let a
 * `cold_legacy` row through the wake — would have been caught in pieces and nowhere as a
 * whole.
 *
 * So this is the whole of it, in one case, with nothing stubbed but Gmail: one firm, one
 * person, `enrollContact` with `originKind: 'prospecting'`, `runDueStepExecution` with
 * the real composition, and `dispatchPreparedStep` through `dispatchOutboundMessage`.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const worker = (): RepositoryContext => world.systemContext(workspaceId());
const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(workspaceId(), {
      kind: 'user',
      userId: world.alpha.workspace.salesperson.userId,
      role: 'salesperson',
    }),
    world.database.session,
  );

/** The worker's hand-off over the fence, as `apps/worker` composes it. */
function fenceHandoff(deps: OutboundSendDeps): SendHandoff {
  const refusal = (reason: string): SendHandoffRefusal =>
    (holdReasonForRefusal(reason) as SendHandoffRefusal | null) ?? 'scoped_pause';
  return {
    prepare: async (handoffContext, request) => {
      const prepared = await prepareOutboundMessage(handoffContext, request);
      return prepared.ok
        ? { ok: true, outboundMessageId: prepared.value.outboundMessageId, created: prepared.value.created }
        : { ok: false, reason: refusal(prepared.reason) };
    },
    dispatch: async (handoffContext, input) => {
      const report = await dispatchOutboundMessage(handoffContext, deps, { outboundMessageId: input.outboundMessageId });
      return report.refusal === undefined ? { ok: true } : { ok: false, reason: refusal(report.refusal) };
    },
    readOutcome: async (handoffContext, stepExecutionId) => await readOutboundOutcome(handoffContext, stepExecutionId),
  };
}

describe('a prospecting enrollment from the command to Gmail', () => {
  it('enrols, wakes, claims and sends exactly one e-mail', async () => {
    const firm = await seedFirm(world, world.alpha, 'prospecting-e2e');
    // A firm with a resolved zone: the command schedules against it.
    await world.database.session.query(
      `UPDATE firms
          SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), firm.firmId],
    );
    const sequenceVersionId = await fixtureSequenceVersionId(world.database.session, {
      workspaceId: workspaceId(),
      firmId: firm.firmId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
    });

    // 1. The command. A cold first touch, with no permission and none needed.
    const enrolled = await enrollContact(salesperson(), {
      sequenceVersionId,
      originKind: 'prospecting',
      opportunityId: firm.opportunityId,
      firmId: firm.firmId,
      contactId: firm.contactId,
    });
    if (!enrolled.ok) throw new Error(`the enrollment was refused: ${enrolled.reason}`);

    // 2. The step the scheduler would wake. Its delay is zero, so it is due at once.
    const [execution] = await listStepExecutions(worker(), { enrollmentId: enrolled.value.enrollmentId });
    if (execution === undefined) throw new Error('the enrollment has no step');

    // 3. The wake, the preparation and the claim, through the real composition.
    // The clock is the step's own: `not_before` is the first instant inside the firm's
    // local sending window, so a minute after it is due *and* inside the window. The
    // dispatch's window clock is pinned to the same instant, as every send test pins it.
    const dueAt = async (): Promise<string> => {
      const { rows: due } = await world.database.session.query<{ at: Date }>(
        `SELECT greatest(due_at, not_before) + interval '1 minute' AS at
           FROM step_executions WHERE workspace_id = $1 AND id = $2`,
        [workspaceId(), execution.id],
      );
      return (due[0]?.at ?? new Date()).toISOString();
    };
    const gmail = world.clientWith(world.alpha, {});
    const look = async (at: string) =>
      await withTransaction(
        world.database.session as Parameters<typeof withTransaction>[0],
        async () =>
          await runDueStepExecution(worker(), {
            stepExecutionId: execution.id,
            now: at,
            eligibility: composeEligibility(),
            sendHandoff: fenceHandoff(world.sendDeps(world.alpha, { gmail, now: () => new Date(at) })),
          }),
      );
    // The first look may only place the step inside the firm's local sending window
    // (11.2, Appendix G 32), which is a reschedule and not a refusal; the second look is
    // the one that hands it to the send.
    let at = await dueAt();
    let ran = await look(at);
    if (ran.kind === 'scheduled') {
      at = await dueAt();
      ran = await look(at);
    }
    if (ran.kind !== 'handed_to_send') throw new Error(`the step was not handed to send: ${ran.kind}`);
    const now = at;
    const dispatched = await dispatchPreparedStep(worker(), {
      stepExecutionId: execution.id,
      outboundMessageId: ran.outboundMessageId,
      sendHandoff: fenceHandoff(world.sendDeps(world.alpha, { gmail, now: () => new Date(now) })),
      now,
    });

    // 4. One e-mail, to this person's own address, and the step says it sent.
    expect(dispatched.kind).toBe('sent');
    expect(gmail.sends).toHaveLength(1);
    expect(gmail.sends[0]?.to).toBe(firm.address);
    const [after] = await listStepExecutions(worker(), { enrollmentId: enrolled.value.enrollmentId });
    expect(after?.state).toBe('completed');
    expect(after?.result).toBe('sent');
  });
});
