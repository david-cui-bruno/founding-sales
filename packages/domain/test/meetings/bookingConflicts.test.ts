import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { prepareFor, seedFirm, type SeededFirm } from '../outbound/support/dispatchFixtures.ts';

/**
 * A demo booked while prospecting is in flight (slice M1, item 4): whatever state the
 * prospecting step is in when the booking commits — pending for later, due now, or
 * already claimed by the worker with a fence prepared — nothing of it is sent afterwards,
 * and the follow-up the prospect agreed to on the call keeps running and sends.
 *
 * The real dispatch path (`dispatchOutboundMessage`, the recorded Gmail client) over the
 * outbound world, so "not sent" is a Gmail client that recorded no send and a report
 * that says why — and "keeps running" is one that recorded exactly one.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
let bookings = 0;

async function book(firm: SeededFirm): Promise<void> {
  bookings += 1;
  const body = {
    triggerEvent: 'BOOKING_CREATED',
    createdAt: new Date().toISOString(),
    payload: {
      uid: `conflict${String(bookings)}x`,
      startTime: '2026-10-20T15:00:00.000Z',
      endTime: '2026-10-20T15:30:00.000Z',
      attendees: [{ email: firm.address }],
    },
  };
  const receipt = await withTransaction(world.database.session, async () =>
    await receiveCalcomEvent(world.database.session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
  );
  expect(receipt).toMatchObject({ outcome: 'applied', meetingState: 'booked' });
}

async function dispatch(fenceId: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(world.systemContext(workspaceId()), world.sendDeps(world.alpha, { gmail }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

/** A prospecting step at the firm, for a contact of its own. */
async function prospectingStep(firm: SeededFirm): Promise<string> {
  return await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    originKind: 'prospecting',
    id: randomUUID(),
  });
}

async function executionState(executionId: string): Promise<{ state: string; enrollment_state: string }> {
  const { rows } = await world.database.session.query<{ state: string; enrollment_state: string }>(
    `SELECT x.state, e.state AS enrollment_state FROM step_executions x
       JOIN sequence_enrollments e ON e.workspace_id = x.workspace_id AND e.id = x.enrollment_id
      WHERE x.workspace_id = $1 AND x.id = $2`,
    [workspaceId(), executionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no execution');
  return row;
}

describe('a booking while a prospecting step is in flight', () => {
  it('sends nothing for a pending step: it is cancelled with its enrollment', async () => {
    const firm = await seedFirm(world, world.alpha, 'booked-pending');
    const step = await prospectingStep(firm);
    await world.database.session.query(
      "UPDATE step_executions SET due_at = now() + interval '2 days', not_before = now() + interval '2 days' WHERE workspace_id = $1 AND id = $2",
      [workspaceId(), step],
    );
    await book(firm);
    expect(await executionState(step)).toEqual({ state: 'cancelled', enrollment_state: 'stopped' });
    // Even a fence prepared for it afterwards — the worker waking on a stale job — sends nothing.
    const late = await dispatch(await prepareFor(world, world.alpha, firm, { stepExecutionId: step }));
    expect(late.sends).toBe(0);
    expect(late.report.outcome).not.toBe('sent');
  });

  it('sends nothing for a step due now', async () => {
    const firm = await seedFirm(world, world.alpha, 'booked-due');
    const step = await prospectingStep(firm);
    await book(firm);
    expect(await executionState(step)).toEqual({ state: 'cancelled', enrollment_state: 'stopped' });
    // Even a fence prepared for it afterwards — the worker waking on a stale job — sends nothing.
    const late = await dispatch(await prepareFor(world, world.alpha, firm, { stepExecutionId: step }));
    expect(late.sends).toBe(0);
    expect(late.report.outcome).not.toBe('sent');
  });

  it('sends nothing for a step the worker already claimed, and the agreed follow-up still sends', async () => {
    const firm = await seedFirm(world, world.alpha, 'booked-claimed');
    const step = await prospectingStep(firm);
    const claimed = await prepareFor(world, world.alpha, firm, { stepExecutionId: step });
    // The follow-up the prospect agreed to on the call (the fixture's default origin).
    const followUp = await prepareFor(world, world.alpha, firm);

    await book(firm);

    const prospecting = await dispatch(claimed);
    expect(prospecting.sends).toBe(0);
    expect(prospecting.report.outcome).not.toBe('sent');
    const agreed = await dispatch(followUp);
    expect(agreed.report.outcome, `${agreed.report.outcome} ${agreed.report.refusal ?? ''} ${agreed.report.detail ?? ''}`).toBe('sent');
    expect(agreed.sends).toBe(1);
  });
});
