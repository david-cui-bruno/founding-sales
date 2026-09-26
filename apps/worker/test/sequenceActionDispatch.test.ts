import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setManualControlMode } from '@fss/domain/crm/pipeline.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { claimJobs, enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import type { GmailClient } from '@fss/domain/mail/gmailClient.ts';
import { readFenceByStepExecution } from '@fss/domain/outbound/fence.ts';
import { claimedAutomatedSends } from '@fss/domain/outbound/ramp.ts';
import { listStepExecutions } from '@fss/domain/sequences/rows.ts';
import { applyManualModeStop } from '@fss/domain/sequences/terminalStops.ts';
import {
  createOutboundWorld,
  type OutboundWorld,
} from '../../../packages/domain/test/outbound/support/outboundWorld.ts';
import {
  automatedSent,
  openExtraSession,
  pausingAtTokenRefresh,
  seedFirm,
  type ExtraSession,
} from '../../../packages/domain/test/outbound/support/dispatchFixtures.ts';
import { outboundSendHandoff } from '../src/handlers/outboundSendHandoff.ts';
import { sequenceActionJobHandler } from '../src/handlers/sequenceAction.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';

/**
 * The real `sequence.action` handler through the fixed dispatch path (lane g77).
 *
 * `sequenceAction.test.ts` proves the job's shape with a recording hand-off. This file
 * wires the one production uses — `outboundSendHandoff` over G7-2's fence, the default
 * eleven-question eligibility, the runner claiming the job — so the step goes from due
 * to prepared to claimed to sent through code nobody stubbed except Gmail.
 *
 * Then the race, through the same wiring. The confirmed reply commits on another
 * connection while the handler is inside its dispatch — at the token refresh, after the
 * step's transaction has committed and the fence is `prepared` — and the claim's
 * recheck must see it: no send, the fence held, the step held with the reason the
 * reply gave it.
 *
 * Wednesday 23 September 2026 at 09:30 New York is the due instant and the dispatch
 * clock, so the window rule leaves the step where it is. No real person, firm or
 * address appears.
 */

const DUE = '2026-09-23T13:30:00.000Z';
const DUE_DATE = '2026-09-23';

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

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());

/** A due email step for a firm of its own, with the contact's route the step will use. */
async function dueEmailStep(label: string): Promise<{
  readonly executionId: string;
  readonly enrollmentId: string;
  readonly firmId: string;
  readonly opportunityId: string;
}> {
  const firm = await seedFirm(world, world.alpha, label);
  const session = world.database.session;
  const executionId = await makeStepExecution(session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
  });
  const { rows } = await session.query<{ enrollment_id: string; contact_id: string }>(
    'SELECT enrollment_id, contact_id FROM step_executions WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), executionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the fixture step execution is missing');
  await session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1')`,
    [workspaceId(), firm.firmId, row.contact_id, `enrolled.${label}@prospect.example.test`],
  );
  await session.query(
    `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), executionId, DUE],
  );
  return { executionId, enrollmentId: row.enrollment_id, firmId: firm.firmId, opportunityId: firm.opportunityId };
}

/** Enqueue, claim and run one `sequence.action` job, the way the worker loop does. */
async function runStep(executionId: string, gmail: GmailClient): Promise<string> {
  const handler = sequenceActionJobHandler({
    sendHandoff: outboundSendHandoff({
      deps: world.sendDeps(world.alpha, { gmail, now: () => new Date(DUE) }),
    }),
  });
  const registry = new HandlerRegistry().register(handler);
  const session = world.database.session;
  await enqueueJob(session, {
    workspaceId: workspaceId(),
    kind: 'sequence.action',
    idempotencyKey: `step-execution:${executionId}`,
    payload: { stepExecutionId: executionId },
    maxAttempts: handler.maxAttempts,
  });
  const [job] = await claimJobs(session, {
    owner: 'g77-worker',
    kinds: ['sequence.action'],
    limit: 1,
    leaseSeconds: handler.leaseSeconds,
  });
  if (job === undefined) throw new Error('the sequence.action job was not claimable');
  return await runClaimedJob(session, { registry, job });
}

describe('sequence.action through the real hand-off and the fixed dispatch path', () => {
  it('sends a due email step once, and the day counts it once', async () => {
    const step = await dueEmailStep('worker-send');
    const gmail = world.clientWith(world.alpha, {});
    const before = await automatedSent(world.database.session, world.alpha, DUE_DATE);

    const outcome = await runStep(step.executionId, gmail);
    expect(outcome).toBe('completed');
    expect(gmail.sends).toHaveLength(1);

    const fence = await readFenceByStepExecution(context(), step.executionId);
    expect(fence?.state).toBe('sent');
    expect(fence?.businessDate).toBe(DUE_DATE);
    const executions = await listStepExecutions(context(), { enrollmentId: step.enrollmentId });
    expect(executions.find(execution => execution.id === step.executionId)?.result).toBe('sent');

    expect(await automatedSent(world.database.session, world.alpha, DUE_DATE)).toBe(before + 1);
    expect(
      await claimedAutomatedSends(context(), { mailboxId: world.alpha.mailboxId, businessDate: DUE_DATE }),
    ).toBe(before + 1);
  });

  it('a reply confirmed while the handler is dispatching stops the send', async () => {
    const step = await dueEmailStep('worker-race');
    const gmail = world.clientWith(world.alpha, {});
    const paused = pausingAtTokenRefresh(gmail, async () => {
      await withTransaction(second.session, async () => {
        const worker = second.context(workspaceId());
        const manual = await setManualControlMode(worker, {
          opportunityId: step.opportunityId,
          reason: 'confirmed human reply',
          origin: 'human_reply',
        });
        expect(manual.ok).toBe(true);
        await applyManualModeStop(worker, { firmId: step.firmId, origin: 'human_reply' });
      });
    });

    const outcome = await runStep(step.executionId, paused.client);
    expect(outcome).toBe('completed');
    // The pause was inside the dispatch: the step's own transaction had prepared the
    // fence and the precheck had passed, or there would have been no token refresh.
    expect(paused.refreshes()).toBe(1);
    expect(gmail.sends).toHaveLength(0);

    const fence = await readFenceByStepExecution(context(), step.executionId);
    expect(fence?.state).toBe('held');
    expect(fence?.heldReason).toBe('step_ineligible');
    const executions = await listStepExecutions(context(), { enrollmentId: step.enrollmentId });
    const execution = executions.find(candidate => candidate.id === step.executionId);
    expect(execution?.state).toBe('held');
    expect(execution?.holdReasonCode).toBe('opportunity_manual');
  });
});
