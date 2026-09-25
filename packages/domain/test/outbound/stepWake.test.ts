import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import type { RepositoryContext } from '../../db/workspaceScope.ts';
import { makeStepExecution } from '../../db/testing/index.ts';
import type { GmailClient, RecordedGmailClient } from '../../mail/index.ts';
import {
  claimedAutomatedSends,
  dispatchOutboundMessage,
  holdReasonForRefusal,
  prepareOutboundMessage,
  readFenceByStepExecution,
  readFenceEvents,
  readOutboundOutcome,
  setAdminCap,
  type OutboundSendDeps,
} from '../../outbound/index.ts';
import {
  composeEligibility,
  dispatchPreparedStep,
  runDueStepExecution,
  type SendHandoff,
  type SendHandoffRefusal,
} from '../../sequences/index.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { automatedSent, openExtraSession, seedFirm, type ExtraSession } from './support/dispatchFixtures.ts';

/**
 * A step's second look at its own fence, through the real dispatch path (lane g82:
 * audit C02, C03).
 *
 * The sequence engine used to dispatch a fence only in the job that prepared it. Now a
 * step woken again — its cap cleared, its worker died before the claim — finds the
 * fence it already has and hands it back to `dispatchOutboundMessage`, which releases a
 * held fence and its own stale holds, rechecks everything under the send gate and
 * claims atomically. These are the outbound half of that: the fence's ledger, its
 * holds and the day's capacity, which must each say "one send" however many looks the
 * step gets.
 *
 * Wednesday 23 September 2026 09:30 New York is the due instant and the dispatch
 * clock. No real person, firm or address appears.
 */

const DUE = '2026-09-23T13:30:00.000Z';
const DUE_DATE = '2026-09-23';

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

afterEach(async () => {
  await second?.session.query('ROLLBACK');
  await third?.session.query('ROLLBACK');
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());

/** G8's hand-off over G7-2's fence, as `apps/worker` composes it, refusals mapped the same way. */
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

/** One look at the step, the way `sequence.action` takes it: decide in a transaction, then dispatch. */
async function look(on: RepositoryContext, stepExecutionId: string, gmail: GmailClient): Promise<string> {
  const handoff = fenceHandoff(world.sendDeps(world.alpha, { gmail, now: () => new Date(DUE) }));
  // The handler's clock is the database's; the dispatch's window clock is pinned to
  // the due Wednesday morning by the deps above.
  const { rows } = await on.db.query<{ now: Date }>('SELECT now() AS now');
  const now = (rows[0]?.now ?? new Date()).toISOString();
  const ran = await withTransaction(
    on.db as Parameters<typeof withTransaction>[0],
    async () =>
      await runDueStepExecution(on, {
        stepExecutionId,
        now,
        eligibility: composeEligibility(),
        sendHandoff: handoff,
      }),
  );
  if (ran.kind !== 'handed_to_send') return ran.kind;
  const dispatched = await dispatchPreparedStep(on, {
    stepExecutionId,
    outboundMessageId: ran.outboundMessageId,
    sendHandoff: handoff,
    now,
  });
  return dispatched.kind;
}

/** A due email step for a firm of its own, with a usable route. */
async function dueEmailStep(label: string): Promise<string> {
  const firm = await seedFirm(world, world.alpha, label);
  const executionId = await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
  });
  await world.database.session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     SELECT workspace_id, firm_id, contact_id, $3, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1'
       FROM step_executions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), executionId, `wake.${label}@prospect.example.test`],
  );
  await world.database.session.query(
    `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), executionId, DUE],
  );
  return executionId;
}

async function ledger(stepExecutionId: string): Promise<readonly string[]> {
  const fence = await readFenceByStepExecution(context(), stepExecutionId);
  if (fence === null) return [];
  return (await readFenceEvents(context(), fence.id)).map(event => `${event.fromState ?? '·'}→${event.toState}`);
}

async function capacity(): Promise<{ readonly counter: number; readonly claimed: number }> {
  return {
    counter: await automatedSent(world.database.session, world.alpha, DUE_DATE),
    claimed: await claimedAutomatedSends(context(), { mailboxId: world.alpha.mailboxId, businessDate: DUE_DATE }),
  };
}

describe('the second look at a capped fence sends it once, and clears only its own stale hold', () => {
  it('held by the cap, then re-dispatched when the cap lifts: held → prepared → dispatching → sent', async () => {
    await world.clearHolds(workspaceId());
    const stepExecutionId = await dueEmailStep('wake-cap');
    const gmail = world.clientWith(world.alpha, {});
    const before = await capacity();
    await setAdminCap(context(), {
      mailboxId: world.alpha.mailboxId,
      adminUserId: world.alpha.workspace.admin.userId,
      lowerTo: 0,
    });
    try {
      expect(await look(context(), stepExecutionId, gmail)).toBe('held');
    } finally {
      await setAdminCap(context(), {
        mailboxId: world.alpha.mailboxId,
        adminUserId: world.alpha.workspace.admin.userId,
        lowerTo: null,
      });
    }
    const fence = await readFenceByStepExecution(context(), stepExecutionId);
    if (fence === null) throw new Error('no fence was prepared');
    const openOwnHolds = async (): Promise<number> => {
      const { rows } = await world.database.session.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM active_holds
          WHERE workspace_id = $1 AND source_event_id = $2 AND released_at IS NULL`,
        [workspaceId(), fence.id],
      );
      return Number(rows[0]?.count ?? '0');
    };
    expect(await openOwnHolds(), 'the cap opened a firm hold, as it should').toBe(1);

    // The hour passes; the step's next look finds its fence rather than a new one.
    await world.database.session.query(
      "UPDATE step_executions SET not_before = now() - interval '1 minute' WHERE workspace_id = $1 AND id = $2",
      [workspaceId(), stepExecutionId],
    );
    expect(await look(context(), stepExecutionId, gmail)).toBe('sent');

    expect(gmail.sends).toHaveLength(1);
    expect(await ledger(stepExecutionId)).toEqual([
      '·→prepared',
      'prepared→held',
      'held→prepared',
      'prepared→dispatching',
      'dispatching→sent',
    ]);
    expect(await openOwnHolds()).toBe(0);
    const after = await capacity();
    expect(after.counter).toBe(before.counter + 1);
    expect(after.claimed).toBe(after.counter);

    // A third look finds the step done and the fence terminal.
    expect(await look(context(), stepExecutionId, gmail)).toBe('nothing_to_do');
    expect(gmail.sends).toHaveLength(1);
  });
});

describe('two looks at one stranded fence, both past the precheck, claim once', () => {
  it('a prepared fence whose worker died is dispatched by exactly one of two concurrent looks', async () => {
    await world.clearHolds(workspaceId());
    const stepExecutionId = await dueEmailStep('wake-race');
    const gmail: RecordedGmailClient = world.clientWith(world.alpha, {});
    const before = await capacity();

    // The step's transaction as the dead worker committed it: fence prepared, step
    // dispatched, and no claim.
    const handoff = fenceHandoff(world.sendDeps(world.alpha, { gmail, now: () => new Date(DUE) }));
    const prepared = await withTransaction(
      world.database.session,
      async () =>
        await runDueStepExecution(context(), {
          stepExecutionId,
          now: new Date().toISOString(),
          eligibility: composeEligibility(),
          sendHandoff: handoff,
        }),
    );
    expect(prepared.kind).toBe('handed_to_send');
    expect((await readFenceByStepExecution(context(), stepExecutionId))?.state).toBe('prepared');

    let arrived = 0;
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>(resolve => {
      release = resolve;
    });
    const timeout = setTimeout(() => release(), 10_000);
    const barrier: GmailClient = {
      ...gmail,
      refreshAccessToken: async (...args: Parameters<GmailClient['refreshAccessToken']>) => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        return await gmail.refreshAccessToken(...args);
      },
    };
    const outcomes = await Promise.all([
      look(second.context(workspaceId()), stepExecutionId, barrier),
      look(third.context(workspaceId()), stepExecutionId, barrier),
    ]);
    clearTimeout(timeout);

    expect(arrived, 'both looks reached the token refresh, so both passed the precheck').toBe(2);
    expect(outcomes).toContain('sent');
    expect(gmail.sends).toHaveLength(1);
    expect((await ledger(stepExecutionId)).filter(entry => entry === 'prepared→dispatching')).toHaveLength(1);
    const after = await capacity();
    expect(after.counter).toBe(before.counter + 1);
    expect(after.claimed).toBe(after.counter);
    const { rows } = await world.database.session.query<{ state: string }>(
      'SELECT state FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), stepExecutionId],
    );
    expect(rows[0]?.state).toBe('completed');
  });
});
