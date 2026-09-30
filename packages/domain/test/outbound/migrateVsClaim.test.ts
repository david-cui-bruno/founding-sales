import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createDraftVersion, publishVersion } from '../../sequences/definitions.ts';
import { migrateEnrollment } from '../../sequences/migrateEnrollment.ts';
import { readEnrollment } from '../../sequences/rows.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { openExtraSession, prepareFor, seedFirm, waitUntilBlocked, type ExtraSession } from './support/dispatchFixtures.ts';

/**
 * The real dispatch claim against a real migration (send-path v2, S2; the lock order in
 * `docs/greenfield/decisions/follow-up-eligibility-20260929.md` §6a and §6d).
 *
 * A migration ends an enrollment, which is a stop fact, so it takes the send gate
 * EXCLUSIVE before any row, the way `logCallOutcome` does since the second review of PR
 * 332. Two cases:
 *
 *   * **The enrollment's own fence.** A claim holding the gate SHARED, stopped by a barrier
 *     on its fence, makes the migration wait at the gate; the claim sends, and the migration
 *     then refuses `enrollment_dispatching`. The claim and the migration never both proceed.
 *   * **Another enrollment's fence at the same firm.** The claim of the other contact's
 *     prospecting fence ends in `firmExclusivitySource`, which locks the firm row. A
 *     migration that took its rows before the gate would hold the firm and then ask for
 *     the gate the claim holds: PostgreSQL's `40P01`. With the gate first, the migration
 *     queues behind the claim and both finish. Remove the gate line from
 *     `migrateEnrollment` and this case deadlocks.
 */

let world: OutboundWorld;
let second: ExtraSession;
let barrier: ExtraSession;
let racer: ExtraSession;

beforeAll(async () => {
  world = await createOutboundWorld();
  second = await openExtraSession(world);
  barrier = await openExtraSession(world);
  racer = await openExtraSession(world);
}, 180_000);

afterAll(async () => {
  await second?.close();
  await barrier?.close();
  await racer?.close();
  await world?.stop();
});

afterEach(async () => {
  await second?.session.query('ROLLBACK');
  await barrier?.session.query('ROLLBACK');
  await racer?.session.query('ROLLBACK');
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const adminOn = (session: ExtraSession['session']): RepositoryContext =>
  repositoryContext(
    workspaceScope(workspaceId(), { kind: 'user', userId: world.alpha.workspace.admin.userId, role: 'admin' }),
    session,
  );

async function prospectingStep(firm: Awaited<ReturnType<typeof seedFirm>>): Promise<string> {
  return await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    originKind: 'prospecting',
  });
}

async function enrollmentOf(stepExecutionId: string): Promise<{ enrollmentId: string; sequenceId: string }> {
  const { rows } = await world.database.session.query<{ enrollment_id: string; sequence_id: string }>(
    `SELECT e.enrollment_id, v.sequence_id
       FROM step_executions e
       JOIN sequence_enrollments n ON n.id = e.enrollment_id
       JOIN sequence_versions v ON v.id = n.sequence_version_id
      WHERE e.id = $1`,
    [stepExecutionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the step execution has no enrollment');
  return { enrollmentId: row.enrollment_id, sequenceId: row.sequence_id };
}

/** Another published version of the fixture sequence, to migrate to. */
async function nextVersion(sequenceId: string): Promise<string> {
  const admin = adminOn(world.database.session);
  const draft = await createDraftVersion(admin, {
    sequenceId,
    steps: [
      { ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 1 }, templateVersionId: world.alpha.templateVersionId },
    ],
  });
  if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
  const published = await publishVersion(admin, { sequenceVersionId: draft.value.sequenceVersionId });
  if (!published.ok) throw new Error(`the publication was refused: ${published.reason}`);
  return draft.value.sequenceVersionId;
}

function noDeadlock(name: string, result: unknown): void {
  const code = (result as { code?: unknown } | null)?.code;
  expect(code, `${name} was aborted: ${String((result as { message?: string } | null)?.message ?? '')}`).not.toBe('40P01');
  expect(result, `${name} threw`).not.toBeInstanceOf(Error);
}

describe('a dispatch claim and a migration', () => {
  it('on the enrollment’s own fence: the claim sends, and the migration waits for it and refuses', async () => {
    const firm = await seedFirm(world, world.alpha, 'own-fence');
    const stepExecutionId = await prospectingStep(firm);
    const fenceId = await prepareFor(world, world.alpha, firm, { stepExecutionId });
    const { enrollmentId, sequenceId } = await enrollmentOf(stepExecutionId);
    const target = await nextVersion(sequenceId);

    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT id FROM outbound_messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId(),
      fenceId,
    ]);
    const gmail = world.clientWith(world.alpha, {});
    const claim = dispatchOutboundMessage(racer.context(workspaceId()), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    await waitUntilBlocked(world.database.session, racer.pid);

    const migration = withTransaction(second.session as Parameters<typeof withTransaction>[0], async () =>
      await migrateEnrollment(adminOn(second.session), { enrollmentId, targetSequenceVersionId: target }),
    );
    // Queued at the gate the claim holds SHARED, before it has locked a row.
    await waitUntilBlocked(world.database.session, second.pid, 'advisory');
    await barrier.session.query('COMMIT');

    const report = await claim.catch((error: unknown) => error);
    const migrated = await migration.catch((error: unknown) => error);
    noDeadlock('the claim', report);
    noDeadlock('the migration', migrated);
    expect((report as SendReport).outcome, JSON.stringify(report)).toBe('sent');
    expect(gmail.sends.length).toBe(1);
    expect(migrated).toEqual({ ok: false, reason: 'enrollment_dispatching' });
    expect((await readEnrollment(adminOn(world.database.session), { enrollmentId }))?.state).toBe('active');
  });

  it('on another enrollment’s fence at the same firm: the migration queues at the gate, and neither deadlocks', async () => {
    const firm = await seedFirm(world, world.alpha, 'firm-row');
    // The firm's earlier prospecting contact, with a prepared fence: the winner of
    // `firmExclusivitySource`, so its claim gets past the precheck and asks for the firm
    // row inside its claim transaction.
    const otherStep = await prospectingStep(firm);
    const fenceId = await prepareFor(world, world.alpha, firm, { stepExecutionId: otherStep });
    // The enrollment to migrate: a later contact at the same firm (the pre-0025 shape the
    // schema still holds), with no fence.
    const migratingStep = await prospectingStep(firm);
    const { enrollmentId, sequenceId } = await enrollmentOf(migratingStep);
    const target = await nextVersion(sequenceId);

    await barrier.session.query('BEGIN');
    await barrier.session.query('SELECT id FROM outbound_messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      workspaceId(),
      fenceId,
    ]);
    const gmail = world.clientWith(world.alpha, {});
    const claim = dispatchOutboundMessage(racer.context(workspaceId()), world.sendDeps(world.alpha, { gmail }), {
      outboundMessageId: fenceId,
    });
    await waitUntilBlocked(world.database.session, racer.pid);

    const migration = withTransaction(second.session as Parameters<typeof withTransaction>[0], async () =>
      await migrateEnrollment(adminOn(second.session), { enrollmentId, targetSequenceVersionId: target }),
    );
    await waitUntilBlocked(world.database.session, second.pid);
    await barrier.session.query('COMMIT');

    const report = await claim.catch((error: unknown) => error);
    const migrated = await migration.catch((error: unknown) => error);
    noDeadlock('the claim', report);
    noDeadlock('the migration', migrated);
    // The claim finished first and sent; the migration then went through.
    expect((report as SendReport).outcome, JSON.stringify(report)).toBe('sent');
    expect(gmail.sends.length).toBe(1);
    expect((migrated as { ok: boolean }).ok, JSON.stringify(migrated)).toBe(true);
  });
});
