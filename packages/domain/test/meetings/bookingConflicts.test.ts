import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { openExtraSession, pausingAtTokenRefresh, prepareFor, seedFirm, type SeededFirm } from '../outbound/support/dispatchFixtures.ts';
import type { SessionQueryable } from '../../db/queryable.ts';

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

async function book(firm: SeededFirm, session: SessionQueryable = world.database.session): Promise<void> {
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
  const receipt = await withTransaction(session, async () =>
    await receiveCalcomEvent(session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
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

  it('holds a prospecting fence prepared before the booking, and the agreed follow-up still sends', async () => {
    // A prepared fence is what the worker holds between planning a send and claiming it.
    // In this release a prospecting fence cannot leave through Gmail at all (the cold
    // outreach rule), so "not sent" is guaranteed twice over; what this case adds is
    // that the booking's own stop reached the claimed step, and that the follow-up's
    // fence, prepared at the same moment, is untouched by it.
    const firm = await seedFirm(world, world.alpha, 'booked-prepared');
    const step = await prospectingStep(firm);
    const prepared = await prepareFor(world, world.alpha, firm, { stepExecutionId: step });
    const followUp = await prepareFor(world, world.alpha, firm);

    await book(firm);

    expect(await executionState(step)).toEqual({ state: 'cancelled', enrollment_state: 'stopped' });
    const prospecting = await dispatch(prepared);
    expect(prospecting.sends).toBe(0);
    expect(prospecting.report.outcome).not.toBe('sent');
    const agreed = await dispatch(followUp);
    expect(agreed.report.outcome, `${agreed.report.outcome} ${agreed.report.refusal ?? ''} ${agreed.report.detail ?? ''}`).toBe('sent');
    expect(agreed.sends).toBe(1);
  });

  it('lets a follow-up whose send is mid-claim finish when a booking commits between its check and its claim', async () => {
    // Appendix G 3's window: the dispatch has read the world and found it sendable, and is
    // refreshing its token before the claiming transaction. The booking commits from
    // another connection in exactly that pause — the stop fact takes the send gate
    // exclusively, the claim takes it shared and re-asks everything. The agreed
    // follow-up is compatible with a booked demo, so the re-asked claim still sends it,
    // once; the firm's prospecting step is cancelled by the same commit.
    const firm = await seedFirm(world, world.alpha, 'booked-mid-claim');
    const step = await prospectingStep(firm);
    const followUp = await prepareFor(world, world.alpha, firm);
    const other = await openExtraSession(world);
    try {
      const gmail = world.clientWith(world.alpha, {});
      const paused = pausingAtTokenRefresh(gmail, async () => {
        await book(firm, other.session);
      });
      const report = await dispatchOutboundMessage(world.systemContext(workspaceId()), world.sendDeps(world.alpha, { gmail: paused.client }), {
        outboundMessageId: followUp,
      });
      expect(paused.refreshes()).toBe(1);
      expect(report.outcome, `${report.outcome} ${report.refusal ?? ''} ${report.detail ?? ''}`).toBe('sent');
      expect(gmail.sends).toHaveLength(1);
      expect(await executionState(step)).toEqual({ state: 'cancelled', enrollment_state: 'stopped' });
    } finally {
      await other.close();
    }
  });
});
