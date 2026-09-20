import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { combinedRecoveryFloor } from '../../outbound/index.ts';
import { enrollContact, enrollmentFloor, stopEnrollments } from '../../sequences/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * The enrollment half of 12.3's recovery floor.
 *
 * "On expired history cursor ... recover from the earlier of watermark minus one hour
 * and the oldest unresolved outbound message or active enrollment."
 *
 * G7-2 implemented the outbound half and left this one as a second source of the same
 * shape. What it means is stated once in
 * `docs/decisions/g8-enrollment-recovery-floor.md` and asserted here: the earliest
 * instant at which a live enrollment of this mailbox's owner actually touched
 * somebody.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let mail: SeededMail;
let sequences: SeededSequences;

const worker = (workspace: 'alpha' | 'beta' = 'alpha'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, { kind: 'system', component: 'worker' }),
    database.session,
  );

/** Enrol the seeded contact and return the enrollment and its first execution. */
async function enrol(): Promise<{ enrollmentId: string; executionId: string }> {
  const enrolled = await enrollContact(
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    ),
    {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    },
  );
  if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
  const { rows } = await database.session.query<{ id: string }>(
    'SELECT id FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2',
    [seeded.alpha.workspaceId, enrolled.value.enrollmentId],
  );
  return { enrollmentId: enrolled.value.enrollmentId, executionId: rows[0]?.id ?? '' };
}

/** Mark a step done at a known instant, the way a send or a call log would. */
async function touchedAt(executionId: string, at: string): Promise<void> {
  await database.session.query(
    `UPDATE step_executions
        SET state = 'completed', completed_at = $3::timestamptz,
            completion_source = 'send', result = 'sent'
      WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, executionId, at],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  mail = await seedMail(database.session, seeded, crm);
  sequences = await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  await database.session.query('DELETE FROM sequence_enrollments');
});

describe('the enrollment half of the recovery floor (12.3)', () => {
  it('is null when the mailbox owner has enrolled nobody', async () => {
    const floor = await enrollmentFloor().oldestUnresolvedAt(worker(), mail.alpha.mailboxId);
    expect(floor).toBeNull();
  });

  it('is null while an enrollment has touched nobody yet', async () => {
    await enrol();
    const floor = await enrollmentFloor().oldestUnresolvedAt(worker(), mail.alpha.mailboxId);
    // Nothing has left FSS, so nothing can be waiting in the mailbox unseen.
    expect(floor).toBeNull();
  });

  it('is the first touch of a live enrollment, not its start', async () => {
    const { executionId } = await enrol();
    await touchedAt(executionId, '2026-09-14T13:00:00.000Z');
    const floor = await enrollmentFloor().oldestUnresolvedAt(worker(), mail.alpha.mailboxId);
    expect(floor).toBe('2026-09-14T13:00:00.000Z');
  });

  it('drops an enrollment that has ended: its reply has already been read', async () => {
    const { enrollmentId, executionId } = await enrol();
    await touchedAt(executionId, '2026-09-14T13:00:00.000Z');
    await stopEnrollments(worker(), { enrollmentId, reason: 'human_reply' });
    const floor = await enrollmentFloor().oldestUnresolvedAt(worker(), mail.alpha.mailboxId);
    expect(floor).toBeNull();
  });

  it('is scoped to the mailbox: another owner’s enrollment is not this one’s floor', async () => {
    const { executionId } = await enrol();
    await touchedAt(executionId, '2026-09-14T13:00:00.000Z');
    // Beta's mailbox, in beta's workspace, sees nothing of alpha's work.
    const floor = await enrollmentFloor().oldestUnresolvedAt(worker('beta'), mail.beta.mailboxId);
    expect(floor).toBeNull();
  });

  it('composes with the outbound half by taking the earlier of the two', async () => {
    const { executionId } = await enrol();
    await touchedAt(executionId, '2026-09-14T13:00:00.000Z');
    const later = {
      oldestUnresolvedAt: async () => await Promise.resolve('2026-09-18T13:00:00.000Z'),
    };
    const combined = combinedRecoveryFloor(later, enrollmentFloor());
    expect(await combined.oldestUnresolvedAt(worker(), mail.alpha.mailboxId)).toBe(
      '2026-09-14T13:00:00.000Z',
    );
  });
});
