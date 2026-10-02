import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { databaseNow } from '../../policy/clock.ts';
import { readFence } from '../../outbound/fence.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import {
  CHANNEL_ACTION_KINDS,
  coldOutreachTransportSource,
  composeEligibility,
  type StepEligibilityOutcome,
} from '../../sequences/eligibility.ts';
import { readEnrollment, readStepExecution } from '../../sequences/rows.ts';
import type { StepChannel } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { pausingAtTokenRefresh, prepareFor, seedFirm } from './support/dispatchFixtures.ts';

/**
 * A prospecting e-mail never leaves through the Gmail dispatch path (send-path v2,
 * slice S4; David, 30 September 2026: "creating an enrollment must not enable cold Gmail
 * outreach").
 *
 * Two halves, one per place the rule is asked:
 *
 *   * **the eligibility source**, `coldOutreachTransportSource`, which holds the step
 *     with `cold_outreach_mailbox_required` (the end-to-end half is in
 *     `prospectingEndToEnd.test.ts`; here, what it answers for each origin and channel);
 *   * **the dispatch claim**, `coldOutreachDispatchRefusal` in `stepPermission.ts`, asked
 *     under the send gate about the fence itself, so a fence that was prepared anyway —
 *     before this rule existed, or held and returning through dispatch — is refused with
 *     Gmail never asked.
 *
 * ## The vacuous-pass trap
 *
 * A refusal proves nothing in a world where nothing could have been sent. The follow-up
 * control below dispatches a fence through the same world, the same mailbox and the same
 * dependencies and requires `sent`.
 *
 * ## Why the claim's detail is asserted exactly
 *
 * The composition is asked again at the claim, and with the source in it a prepared
 * prospecting fence is refused there too (detail `cold_outreach_mailbox_required`).
 * The claim's own check runs first and names the path and the mailbox kind
 * (`cold_outreach_mailbox_required:gmail_dispatch:<kind>`), so the exact detail is what
 * distinguishes the claim's rule from the source's: with the claim's check removed the
 * detail loses its suffix and the case fails.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());

/** A prepared fence for a new contact at a firm of its own, of the named origin. */
async function preparedFence(
  label: string,
  originKind: 'prospecting' | 'follow_up' | 'cold_legacy',
): Promise<{ readonly fenceId: string; readonly stepExecutionId: string }> {
  const firm = await seedFirm(world, world.alpha, label);
  const stepExecutionId = await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    originKind,
  });
  return { fenceId: await prepareFor(world, world.alpha, firm, { stepExecutionId }), stepExecutionId };
}

async function dispatch(fenceId: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

/** Ask the source alone about one step execution, as the composition would. */
async function askSource(stepExecutionId: string, channel?: StepChannel): Promise<StepEligibilityOutcome> {
  const execution = await readStepExecution(context(), stepExecutionId);
  if (execution === null) throw new Error('the step execution disappeared');
  const enrollment = await readEnrollment(context(), { enrollmentId: execution.enrollmentId });
  if (enrollment === null) throw new Error('the enrollment disappeared');
  const asked = channel ?? execution.channel;
  const input = {
    execution,
    opportunityId: enrollment.opportunityId,
    firmId: enrollment.firmId,
    contactId: enrollment.contactId,
    ownerUserId: enrollment.assignedUserId,
    channel: asked,
    actionKind: CHANNEL_ACTION_KINDS[asked],
    now: await databaseNow(context()),
  };
  return await coldOutreachTransportSource().evaluate(context(), input);
}

describe('the eligibility source', () => {
  it('refuses a prospecting e-mail step with cold_outreach_mailbox_required', async () => {
    const { stepExecutionId } = await preparedFence('source-prospecting', 'prospecting');
    expect(await askSource(stepExecutionId)).toEqual({ ok: false, reasonCode: 'cold_outreach_mailbox_required' });
  });

  it('passes a prospecting call task: a person dialling is not Gmail', async () => {
    const { stepExecutionId } = await preparedFence('source-call', 'prospecting');
    expect(await askSource(stepExecutionId, 'call_task')).toEqual({ ok: true });
  });

  it('passes a follow-up e-mail step', async () => {
    const { stepExecutionId } = await preparedFence('source-follow-up', 'follow_up');
    expect(await askSource(stepExecutionId)).toEqual({ ok: true });
  });

  it('leaves cold_legacy to the source before it: the composition still answers cold_legacy', async () => {
    const { stepExecutionId } = await preparedFence('source-legacy', 'cold_legacy');
    const execution = await readStepExecution(context(), stepExecutionId);
    if (execution === null) throw new Error('the step execution disappeared');
    const enrollment = await readEnrollment(context(), { enrollmentId: execution.enrollmentId });
    if (enrollment === null) throw new Error('the enrollment disappeared');
    const outcome = await composeEligibility().evaluate(context(), {
      execution,
      opportunityId: enrollment.opportunityId,
      firmId: enrollment.firmId,
      contactId: enrollment.contactId,
      ownerUserId: enrollment.assignedUserId,
      channel: 'email',
      actionKind: CHANNEL_ACTION_KINDS.email,
      now: await databaseNow(context()),
    });
    expect(outcome).toEqual({ ok: false, reasonCode: 'cold_legacy' });
  });
});

describe('the dispatch claim', () => {
  it('sends a prepared follow-up fence through the same world (the control)', async () => {
    const { fenceId } = await preparedFence('claim-follow-up', 'follow_up');
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, JSON.stringify(report)).toBe('sent');
    expect(sends).toBe(1);
  });

  it('refuses a prepared prospecting fence: zero Gmail calls, and the fence is not sent', async () => {
    const { fenceId } = await preparedFence('claim-prospecting', 'prospecting');
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, JSON.stringify(report)).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail).toBe('cold_outreach_mailbox_required:gmail_dispatch:personal');
    expect(sends).toBe(0);
    const fence = await readFence(context(), fenceId);
    expect(fence?.state).toBe('held');
    expect(fence?.heldReason).toBe('step_ineligible');
  });

  it('refuses inside the claiming transaction, under the send gate, when the precheck passed', async () => {
    // The precheck above runs before the token refresh and outside any transaction; the
    // claim asks again under the send gate. A fence whose enrollment is a follow-up at
    // the precheck and prospecting by the claim is not a state the product produces
    // (nothing rewrites an origin); it is the one way to prove that the second asking,
    // and not only the first, refuses. The refresh count says the precheck passed.
    const { fenceId } = await preparedFence('claim-under-gate', 'follow_up');
    const gmail = world.clientWith(world.alpha, {});
    const paused = pausingAtTokenRefresh(gmail, async () => {
      await world.database.session.query(
        `UPDATE sequence_enrollments SET origin_kind = 'prospecting'
          WHERE workspace_id = $1
            AND id = (SELECT enrollment_id FROM outbound_messages WHERE workspace_id = $1 AND id = $2)`,
        [workspaceId(), fenceId],
      );
    });
    const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail: paused.client }), {
      outboundMessageId: fenceId,
    });
    expect(paused.refreshes()).toBe(1);
    expect(report.outcome, JSON.stringify(report)).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail).toBe('cold_outreach_mailbox_required:gmail_dispatch:personal');
    expect(gmail.sends).toHaveLength(0);
    expect((await readFence(context(), fenceId))?.state).toBe('held');
  });

  it('reports an opt-out on another address of the same person as the suppression, never the cold hold', async () => {
    // Review P2-a. `decideSend` checks the firm and the fence's own recipient address;
    // an opt-out recorded on the contact's *other* address is seen only by the
    // composition's contact-wide `suppressionSource`, which is asked before the
    // cold-outreach refusal so that the reason reported is the one that matters.
    const { fenceId, stepExecutionId } = await preparedFence('claim-opted-out', 'prospecting');
    const { rows } = await world.database.session.query<{ firm_id: string; contact_id: string }>(
      'SELECT firm_id, contact_id FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), stepExecutionId],
    );
    const step = rows[0];
    if (step === undefined) throw new Error('the step execution disappeared');
    const alternate = `alternate.${stepExecutionId.slice(0, 8)}@example.test`;
    await world.database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId(), step.firm_id, step.contact_id, alternate],
    );
    const salesperson = repositoryContext(
      workspaceScope(workspaceId(), {
        kind: 'user',
        userId: world.alpha.workspace.salesperson.userId,
        role: 'salesperson',
      }),
      world.database.session,
    );
    const suppressed = await recordSuppression(salesperson, {
      scope: 'handle',
      firmId: step.firm_id,
      value: alternate,
      source: 'prospect_opt_out',
      channel: 'all',
      journal: recordingSuppressionJournal(),
    });
    expect(suppressed.ok).toBe(true);

    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, JSON.stringify(report)).toBe('held');
    expect(report.refusal).toBe('handle_suppressed');
    expect(report.detail ?? '').not.toContain('cold_outreach_mailbox_required');
    expect(sends).toBe(0);
  });

  it('refuses it again when the held fence returns through dispatch', async () => {
    const { fenceId } = await preparedFence('claim-returning', 'prospecting');
    const first = await dispatch(fenceId);
    expect(first.report.outcome).toBe('held');
    // `dispatchOutboundMessage` releases a held fence and asks the gate again: the path
    // a held fence takes every time the step is woken.
    const again = await dispatch(fenceId);
    expect(again.report.outcome, JSON.stringify(again.report)).toBe('held');
    expect(again.report.detail).toBe('cold_outreach_mailbox_required:gmail_dispatch:personal');
    expect(first.sends + again.sends).toBe(0);
  });

  it('is not lifted by labelling the mailbox cold_outreach (P0-5)', async () => {
    const { fenceId } = await preparedFence('claim-label', 'prospecting');
    await world.database.session.query("UPDATE mailboxes SET kind = 'cold_outreach' WHERE workspace_id = $1 AND id = $2", [
      workspaceId(),
      world.alpha.mailboxId,
    ]);
    try {
      const { report, sends } = await dispatch(fenceId);
      expect(report.outcome, JSON.stringify(report)).toBe('held');
      expect(report.detail).toBe('cold_outreach_mailbox_required:gmail_dispatch:cold_outreach');
      expect(sends).toBe(0);
    } finally {
      await world.database.session.query("UPDATE mailboxes SET kind = 'personal' WHERE workspace_id = $1 AND id = $2", [
        workspaceId(),
        world.alpha.mailboxId,
      ]);
    }
  });

  it('leaves a cold_legacy fence refused exactly as before', async () => {
    const { fenceId } = await preparedFence('claim-legacy', 'cold_legacy');
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, JSON.stringify(report)).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail).toBe('cold_legacy');
    expect(sends).toBe(0);
  });
});
