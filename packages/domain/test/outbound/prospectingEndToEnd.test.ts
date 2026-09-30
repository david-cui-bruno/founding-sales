import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { fixtureSequenceVersionId } from '../../db/testing/stepExecutions.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { prepareOutboundMessage, readOutboundOutcome } from '../../outbound/fence.ts';
import { holdReasonForRefusal } from '../../outbound/gate.ts';
import { dispatchOutboundMessage, type OutboundSendDeps } from '../../outbound/send.ts';
import { composeEligibility } from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { listStepExecutions } from '../../sequences/rows.ts';
import { listStepWakes } from '../../sequences/wake.ts';
import type { SendHandoff, SendHandoffRefusal } from '../../sequences/sendHandoff.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { seedFirm } from './support/dispatchFixtures.ts';

/**
 * A cold first touch, end to end: the command a person gives, the step the scheduler
 * wakes, and the eligibility that holds it (P2-2 of the GPT-6 review of PR 332; send-path
 * v2, slice S4).
 *
 * Migration 0025 made every enrollment say what it is for, and the shared step-execution
 * fixture chose `follow_up` for the reason its header gives. That left the repository
 * with no test of the *other* origin along the whole path, so this file walks it: one
 * firm, one person, `enrollContact` with `originKind: 'prospecting'`, and
 * `runDueStepExecution` with the real composition and a hand-off over the real fence and
 * the real dispatch, with nothing stubbed but Gmail.
 *
 * Until send-path v2 the walk ended in one e-mail at the fake Gmail. David, 30 September
 * 2026: "creating an enrollment must not enable cold Gmail outreach". So it now ends in
 * a held step: `coldOutreachTransportSource` refuses the prospecting e-mail with
 * `cold_outreach_mailbox_required`, `runDueStepExecution` stores it as the step's
 * `hold_reason_code` (which references `hold_reason_codes`, extended by migration
 * 0026), no fence is prepared, and Gmail is never asked. The enrollment is still live —
 * the hold is visible, not an ending.
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

describe('a prospecting enrollment from the command to the held step', () => {
  it('enrols, wakes, and holds the e-mail with cold_outreach_mailbox_required: no fence, no Gmail call', async () => {
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
    expect(execution.channel).toBe('email');

    // 3. The wake and the eligibility, through the real composition, a minute after the
    // step is due and inside the firm's window (the first look may only place it there,
    // which is a reschedule and not a refusal).
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
    let ran = await look(await dueAt());
    if (ran.kind === 'scheduled') ran = await look(await dueAt());

    // 4. Held, for the reason an operator reads, and stored where a card reads it.
    expect(ran).toEqual({ kind: 'held', stepExecutionId: execution.id, reasonCode: 'cold_outreach_mailbox_required' });
    const { rows: stored } = await world.database.session.query<{
      state: string;
      hold_reason_code: string | null;
      recoverable: boolean | null;
    }>(
      `SELECT e.state, e.hold_reason_code, c.recoverable
         FROM step_executions e
         LEFT JOIN hold_reason_codes c ON c.code = e.hold_reason_code
        WHERE e.workspace_id = $1 AND e.id = $2`,
      [workspaceId(), execution.id],
    );
    expect(stored).toEqual([{ state: 'held', hold_reason_code: 'cold_outreach_mailbox_required', recoverable: true }]);

    // 5. Nothing was prepared and nothing reached Gmail; the enrollment is still live.
    const { rows: fences } = await world.database.session.query(
      'SELECT id FROM outbound_messages WHERE workspace_id = $1 AND step_execution_id = $2',
      [workspaceId(), execution.id],
    );
    expect(fences).toHaveLength(0);
    expect(gmail.sends).toHaveLength(0);
    const { rows: live } = await world.database.session.query<{ ended_at: Date | null }>(
      'SELECT ended_at FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), enrolled.value.enrollmentId],
    );
    expect(live[0]?.ended_at).toBeNull();

    // 6. And the scheduler keeps asking (review P2-b): `listStepWakes` does not wake the
    // held step before its `not_before`, and does wake it after, so the hold is re-read
    // and stays visible rather than going quiet. (`wake.ts` is untouched by send-path v2:
    // it excludes `cold_legacy`, not `prospecting`.)
    const { rows: timing } = await world.database.session.query<{ before: Date; after: Date }>(
      `SELECT not_before - interval '1 minute' AS before, not_before + interval '1 minute' AS after
         FROM step_executions WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), execution.id],
    );
    const window = timing[0];
    if (window === undefined) throw new Error('the held step disappeared');
    const wokenAt = async (at: Date): Promise<boolean> =>
      (await listStepWakes(world.database.session, { now: at.toISOString(), limit: 1000 })).some(
        wake => wake.stepExecutionId === execution.id,
      );
    expect(await wokenAt(window.before)).toBe(false);
    expect(await wokenAt(window.after)).toBe(true);
  });
});
