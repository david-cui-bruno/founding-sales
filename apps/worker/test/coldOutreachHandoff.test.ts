import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { claimJobs, enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import type { GmailClient } from '@fss/domain/mail/gmailClient.ts';
import { readFenceByStepExecution } from '@fss/domain/outbound/fence.ts';
import {
  createOutboundWorld,
  type OutboundWorld,
} from '../../../packages/domain/test/outbound/support/outboundWorld.ts';
import { prepareFor, seedFirm } from '../../../packages/domain/test/outbound/support/dispatchFixtures.ts';
import { outboundSendHandoff } from '../src/handlers/outboundSendHandoff.ts';
import { sequenceActionJobHandler } from '../src/handlers/sequenceAction.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';

/**
 * A prepared prospecting fence, refused at the claim, leaves its step held with the
 * reason a card can act on (send-path v2, slice S4; review P1-a).
 *
 * A fence prepared before the cold-outreach rule existed never meets the eligibility
 * source again: `runDueStepExecution` hands a `prepared` or `held` fence straight back to
 * the dispatch path. So the step's stored reason comes from the claim's refusal —
 * `step_ineligible`, detail `cold_outreach_mailbox_required:gmail_dispatch:<kind>` —
 * through the worker's real hand-off (`outboundSendHandoff`'s `refusalFor`) and
 * `dispatchPreparedStep`. Before the fix the hand-off did not know the code and the step
 * was held `scoped_pause`, which reads as "somebody paused this".
 *
 * The real `sequence.action` handler, the runner claiming the job, the default
 * eligibility, and nothing stubbed but Gmail. Wednesday 23 September 2026, 09:30 New
 * York, pins the dispatch clock inside the window. No real person, firm or address.
 */

const DUE = '2026-09-23T13:30:00.000Z';

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());

/** Enqueue, claim and run one `sequence.action` job, the way the worker loop does. */
async function runStep(executionId: string, attempt: string, gmail: GmailClient): Promise<string> {
  const handler = sequenceActionJobHandler({
    now: () => DUE,
    sendHandoff: outboundSendHandoff({
      deps: world.sendDeps(world.alpha, { gmail, now: () => new Date(DUE) }),
    }),
  });
  const registry = new HandlerRegistry().register(handler);
  const session = world.database.session;
  await enqueueJob(session, {
    workspaceId: workspaceId(),
    kind: 'sequence.action',
    idempotencyKey: `step-execution:${executionId}:${attempt}`,
    payload: { stepExecutionId: executionId },
    maxAttempts: handler.maxAttempts,
  });
  const [job] = await claimJobs(session, {
    owner: 's4-worker',
    kinds: ['sequence.action'],
    limit: 1,
    leaseSeconds: handler.leaseSeconds,
  });
  if (job === undefined) throw new Error('the sequence.action job was not claimable');
  return await runClaimedJob(session, { registry, job });
}

async function storedStep(executionId: string): Promise<{ state: string; hold_reason_code: string | null }> {
  const { rows } = await world.database.session.query<{ state: string; hold_reason_code: string | null }>(
    'SELECT state, hold_reason_code FROM step_executions WHERE workspace_id = $1 AND id = $2',
    [workspaceId(), executionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the step execution disappeared');
  return row;
}

describe('a prepared prospecting fence through the worker hand-off', () => {
  it('holds the step cold_outreach_mailbox_required when prepared, and again when resumed', async () => {
    const firm = await seedFirm(world, world.alpha, 'handoff-cold');
    const executionId = await makeStepExecution(world.database.session, {
      workspaceId: workspaceId(),
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
      originKind: 'prospecting',
    });
    // Align the fixture's due instant with both pinned handler and dispatch clocks.
    await world.database.session.query('UPDATE step_executions SET due_at=$2,not_before=$2 WHERE id=$1',[executionId,DUE]);
    // A fence prepared as if before the rule: the eligibility source is never asked
    // about it again, only the claim is.
    await prepareFor(world, world.alpha, firm, { stepExecutionId: executionId });

    // Prepared: the handler hands the fence back to the dispatch, the claim refuses.
    const gmail = world.clientWith(world.alpha, {});
    expect(await runStep(executionId, 'prepared', gmail)).toBe('completed');
    expect(gmail.sends).toHaveLength(0);
    expect(await storedStep(executionId)).toEqual({ state: 'held', hold_reason_code: 'cold_outreach_mailbox_required' });
    const fence = await readFenceByStepExecution(context(), executionId);
    expect(fence?.state).toBe('held');
    expect(fence?.heldReason).toBe('step_ineligible');

    // Resumed: the held step is woken after its `not_before`, the held fence is released
    // and decided again. The stored reason is first set to what the hand-off wrote before
    // the fix (`scoped_pause`), so the resumed dispatch has to write the right one itself
    // rather than leave the first attempt's in place.
    await world.database.session.query(
      `UPDATE step_executions SET not_before = $3::timestamptz - interval '1 minute', hold_reason_code = 'scoped_pause'
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), executionId, DUE],
    );
    const again = world.clientWith(world.alpha, {});
    expect(await runStep(executionId, 'resumed', again)).toBe('completed');
    expect(again.sends).toHaveLength(0);
    expect(await storedStep(executionId)).toEqual({ state: 'held', hold_reason_code: 'cold_outreach_mailbox_required' });
    expect((await readFenceByStepExecution(context(), executionId))?.state).toBe('held');
  });
});
