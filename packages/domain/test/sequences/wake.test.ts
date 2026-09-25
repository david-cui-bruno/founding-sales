import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '../../db/testing/index.ts';
import { openHold, releaseHold, type OpenHoldInput } from '../../policy/index.ts';
import { readFence } from '../../outbound/index.ts';
import {
  holdSource,
  listStepWakes,
  readStepExecution,
  resumeEnrollment,
} from '../../sequences/index.ts';
import { createOutboundWorld, type OutboundWorld } from '../outbound/support/outboundWorld.ts';
import { prepareFor, seedFirm, type SeededFirm } from '../outbound/support/dispatchFixtures.ts';

/**
 * Which held steps the scheduler wakes, and that it agrees with eligibility about why
 * (lane g82: audit C05, C10).
 *
 * `listStepWakes` skips a held step while an open hold blocks it and takes it on the
 * first pass after the release; `holdSource` — the eligibility read the step's run and
 * the dispatch claim both make — refuses it for exactly as long; and the resume that
 * the run starts with (4.3) sees the same hold open. Three readers, one answer, for
 * every scope `active_holds` can carry. Before lane g82 the wake took no held step
 * but four clock-clearing reasons, whose jobs then never ran again, and the resume
 * asked five scopes of the seven.
 *
 * A vacuous pass would be a hold that blocks nothing, so each case also requires the
 * step to be woken, and the eligibility to pass, once the hold is released.
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

interface HeldStep {
  readonly executionId: string;
  readonly enrollmentId: string;
  readonly firm: SeededFirm;
}

/** A step of a firm of its own, due and past its `not_before`, and held. */
async function heldStep(label: string, firm?: SeededFirm, executionId?: string): Promise<HeldStep> {
  const owner = firm ?? (await seedFirm(world, world.alpha, label));
  const id =
    executionId ??
    (await makeStepExecution(world.database.session, {
      workspaceId: workspaceId(),
      firmId: owner.firmId,
      opportunityId: owner.opportunityId,
      userId: world.alpha.workspace.salesperson.userId,
      templateVersionId: world.alpha.templateVersionId,
    }));
  const { rows } = await world.database.session.query<{ enrollment_id: string }>(
    `UPDATE step_executions
        SET state = 'held', hold_reason_code = 'scoped_pause',
            due_at = now() - interval '1 hour', not_before = now() - interval '1 hour',
            original_due_at = now() - interval '1 hour', updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING enrollment_id`,
    [workspaceId(), id],
  );
  const enrollmentId = rows[0]?.enrollment_id;
  if (enrollmentId === undefined) throw new Error('the fixture step is missing');
  return { executionId: id, enrollmentId, firm: owner };
}

async function woken(step: HeldStep): Promise<boolean> {
  const { rows } = await world.database.session.query<{ now: Date }>('SELECT now() AS now');
  const wakes = await listStepWakes(world.database.session, { now: (rows[0]?.now ?? new Date()).toISOString() });
  return wakes.some(wake => wake.stepExecutionId === step.executionId);
}

/** `holdSource`'s answer for the step, as the run and the dispatch claim ask it. */
async function eligible(step: HeldStep): Promise<boolean> {
  const execution = await readStepExecution(context(), step.executionId);
  if (execution === null) throw new Error('the fixture step is missing');
  const outcome = await holdSource().evaluate(context(), {
    execution,
    opportunityId: step.firm.opportunityId,
    firmId: step.firm.firmId,
    contactId: execution.contactId,
    ownerUserId: world.alpha.workspace.salesperson.userId,
    channel: 'email',
    actionKind: 'email_send',
    now: new Date().toISOString(),
  });
  return outcome.ok;
}

type Scope = OpenHoldInput['scopeKind'];

const SCOPES: readonly { readonly scope: Scope; readonly key: (step: HeldStep) => string | undefined }[] = [
  { scope: 'workspace', key: () => undefined },
  { scope: 'firm', key: step => step.firm.firmId },
  { scope: 'opportunity', key: step => step.firm.opportunityId },
  { scope: 'owner', key: () => world.alpha.workspace.salesperson.userId },
  { scope: 'mailbox', key: () => world.alpha.mailboxId },
  { scope: 'enrollment', key: step => step.enrollmentId },
  { scope: 'channel', key: () => 'email' },
];

describe('C10: a held step is woken exactly when eligibility would let it through', () => {
  for (const { scope, key } of SCOPES) {
    it(`a ${scope} hold keeps it asleep and refused, and its release wakes it and lets it through`, async () => {
      const step = await heldStep(`wake-${scope}`);
      expect(await woken(step), 'unblocked, a held step past its not_before is woken').toBe(true);

      const scopeKey = key(step);
      const holdId = await openHold(context(), {
        scopeKind: scope,
        ...(scopeKey === undefined ? {} : { scopeKey }),
        reasonCode: 'scoped_pause',
        blockedActionKinds: ['email_send', 'enrollment_advance'],
        sourceEventKind: 'test.g82',
      });
      try {
        expect(await eligible(step), 'eligibility refuses while the hold is open').toBe(false);
        expect(await woken(step), 'the wake agrees and does not take it').toBe(false);
        const resumed = await resumeEnrollment(context(), { enrollmentId: step.enrollmentId });
        expect(resumed.ok && resumed.value.kind, 'the resume sees the same hold open').toBe('still_held');
      } finally {
        await releaseHold(context(), holdId);
      }

      expect(await eligible(step)).toBe(true);
      expect(await woken(step), 'the pass after the release takes it (C05)').toBe(true);
    });
  }

  it('a hold on another channel, or on call work only, blocks neither side for an email step', async () => {
    const step = await heldStep('wake-other-channel');
    const callChannel = await openHold(context(), {
      scopeKind: 'channel',
      scopeKey: 'call',
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['call_task'],
      sourceEventKind: 'test.g82',
    });
    const callWork = await openHold(context(), {
      scopeKind: 'firm',
      scopeKey: step.firm.firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['call_task'],
      sourceEventKind: 'test.g82',
    });
    try {
      expect(await eligible(step)).toBe(true);
      expect(await woken(step)).toBe(true);
    } finally {
      await releaseHold(context(), callChannel);
      await releaseHold(context(), callWork);
    }
  });
});

describe('a step’s own fence does not keep it asleep, and does keep its neighbours asleep', () => {
  it('the firm hold a capped fence opened wakes its own step and blocks the next step at the firm', async () => {
    const firm = await seedFirm(world, world.alpha, 'wake-own-fence');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const fence = await readFence(context(), fenceId);
    if (fence?.stepExecutionId === undefined || fence.stepExecutionId === null) throw new Error('no fence step');
    const own = await heldStep('wake-own-fence', firm, fence.stepExecutionId);
    const neighbour = await heldStep('wake-own-fence', firm);

    // What `dispatchOutboundMessage` opens when the day's cap refuses a fence.
    const capHold = await openHold(context(), {
      scopeKind: 'firm',
      scopeKey: firm.firmId,
      reasonCode: 'daily_cap',
      blockedActionKinds: ['email_send'],
      sourceEventKind: 'outbound_message',
      sourceEventId: fenceId,
    });
    try {
      // Its own step is re-dispatched later, and the dispatch releases this hold and
      // decides again; waiting for somebody else to release it would wait for ever.
      expect(await woken(own)).toBe(true);
      // Anybody else's email at the firm waits for the cap, as the eligibility says.
      expect(await eligible(neighbour)).toBe(false);
      expect(await woken(neighbour)).toBe(false);
    } finally {
      await releaseHold(context(), capHold);
    }
    expect(await woken(neighbour)).toBe(true);
  });
});
