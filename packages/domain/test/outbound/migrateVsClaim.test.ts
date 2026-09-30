import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createDraftVersion, publishVersion } from '../../sequences/definitions.ts';
import { migrateEnrollment } from '../../sequences/migrateEnrollment.ts';
import { grantFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { readEnrollment } from '../../sequences/rows.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { openExtraSession, prepareFor, seedFirm, waitUntilBlocked, type ExtraSession } from './support/dispatchFixtures.ts';

/**
 * The real dispatch claim against a real migration (send-path v2, S2; the lock order in
 * `docs/greenfield/decisions/follow-up-eligibility-20260929.md` §6a and §6d).
 *
 * Every send here is an **evidenced follow-up** (`makeStepExecution`'s default: an
 * `agreed_sequence` permission on a recorded interested call), not a prospecting e-mail,
 * so the cases keep sending once prospecting mail through a conversation mailbox is
 * refused (S4; PR 335 review, P2-b).
 *
 * A migration ends an enrollment, which is a stop fact, so it takes the send gate
 * EXCLUSIVE before any row, the way `logCallOutcome` does since the second review of PR
 * 332. Two cases:
 *
 *   * **The enrollment's own fence.** A claim holding the gate SHARED, stopped by a barrier
 *     on its fence, makes the migration wait at the gate (an advisory wait — remove the
 *     gate line from `migrateEnrollment` and this case fails); the claim sends, and the
 *     migration then refuses `enrollment_dispatching`. The two never both proceed.
 *   * **Another enrollment's fence at the same firm.** The migration of the firm's
 *     prospecting contact queues behind the follow-up claim of a colleague and both finish:
 *     the claim sends, the migration goes through, and neither is aborted. A follow-up
 *     claim does not lock the firm row (`firmExclusivitySource` is prospecting-only), so
 *     this case proves the two coexist rather than the firm-row deadlock the gate would
 *     prevent for a prospecting claim.
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

async function stepFor(
  firm: Awaited<ReturnType<typeof seedFirm>>,
  originKind: 'prospecting' | 'follow_up',
): Promise<string> {
  return await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: firm.firmId,
    opportunityId: firm.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    originKind,
  });
}

/** A fresh `agreed_sequence` permission for `versionId`, for the enrollment's contact. */
async function freshPermission(enrollmentId: string, versionId: string): Promise<string> {
  const enrollment = await readEnrollment(adminOn(world.database.session), { enrollmentId });
  if (enrollment === null) throw new Error('the enrollment disappeared');
  const { rows } = await world.database.session.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
        actor_user_id, agreed_follow_up, agreed_sequence_version_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5, 'agreed_sequence', $6)
     RETURNING id`,
    [workspaceId(), enrollment.firmId, enrollment.contactId, enrollment.opportunityId, world.alpha.workspace.salesperson.userId, versionId],
  );
  const granted = await grantFollowUpPermission(adminOn(world.database.session), {
    firmId: enrollment.firmId,
    contactId: enrollment.contactId,
    callLogId: rows[0]?.id ?? '',
    grantedByUserId: world.alpha.workspace.admin.userId,
  });
  if (!granted.ok) throw new Error(`the permission was refused: ${granted.reason}`);
  return granted.value.id;
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
    const stepExecutionId = await stepFor(firm, 'follow_up');
    const fenceId = await prepareFor(world, world.alpha, firm, { stepExecutionId });
    const { enrollmentId, sequenceId } = await enrollmentOf(stepExecutionId);
    const target = await nextVersion(sequenceId);
    // A follow-up moves only on a fresh permission for the target; offered one, the
    // refusal it meets is the fence's.
    const permissionId = await freshPermission(enrollmentId, target);

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
      await migrateEnrollment(adminOn(second.session), { enrollmentId, targetSequenceVersionId: target, permissionId }),
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

  it('on another enrollment’s fence at the same firm: the migration queues behind the claim, and both finish', async () => {
    const firm = await seedFirm(world, world.alpha, 'firm-row');
    // A colleague's evidenced follow-up, with a prepared fence.
    const otherStep = await stepFor(firm, 'follow_up');
    const fenceId = await prepareFor(world, world.alpha, firm, { stepExecutionId: otherStep });
    // The enrollment to migrate: the firm's prospecting contact, with no fence.
    const migratingStep = await stepFor(firm, 'prospecting');
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
