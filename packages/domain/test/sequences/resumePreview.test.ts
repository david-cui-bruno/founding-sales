import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { openHold, releaseHold } from '../../policy/holds.ts';
import { enrollContact, stopEnrollments } from '../../sequences/enrollments.ts';
import { previewResume, resumeEnrollment } from '../../sequences/resume.ts';
import { listStepExecutions, readEnrollment } from '../../sequences/rows.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * "Review and resume" shows the review (lane g88, audit G06; specification 4.3).
 *
 * Installed desktops up to 1.0.11 show `previewResume` before they confirm a resume, for
 * an enrollment an older release left in `review_required` (a long hold resumes on its
 * own since wave 2, S4.1). This file holds it to two promises: it changes nothing, and
 * the dates it shows are the dates the confirmation gives the steps.
 *
 * **The vacuous-pass trap.** A preview whose `proposedDueAt` equals `dueAt` agrees with a
 * resume that moves nothing, and a nine-day hold that the fixture forgot to release would
 * make both "still held". So the hold here is released, nine days long, and the proposed
 * instant is required to be nine days later than the current one — and then to be exactly
 * where the confirmation put the step.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

const contextFor = (workspace: 'alpha' | 'beta', who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, { kind: 'user', userId: seeded[workspace][who].userId, role: who }),
    database.session,
  );

const DAY = 86_400_000;

async function enrollAlpha(): Promise<string> {
  const result = await enrollContact(contextFor('alpha', 'salesperson'), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId: crm.alpha.contactId,
  });
  if (!result.ok) throw new Error(`the enrollment fixture was refused: ${result.reason}`);
  // Lived through the hold below: started ten days ago.
  await database.session.query(
    `UPDATE sequence_enrollments SET started_at = now() - interval '10 days' WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, result.value.enrollmentId],
  );
  return result.value.enrollmentId;
}

/** A pause of the firm that started `days` ago; released unless `open`. */
async function pause(days: number, options: { readonly open?: boolean } = {}): Promise<string> {
  const context = contextFor('alpha', 'admin');
  const hold = await openHold(context, {
    scopeKind: 'firm',
    scopeKey: crm.alpha.firmId,
    reasonCode: 'scoped_pause',
    blockedActionKinds: ['email_send', 'enrollment_advance'],
    sourceEventKind: 'test.g88',
  });
  await database.session.query(`UPDATE active_holds SET started_at = now() - $2::interval WHERE id = $1`, [
    hold,
    `${String(days)} days`,
  ]);
  if (options.open !== true) await releaseHold(context, hold);
  return hold;
}

async function snapshot(enrollmentId: string): Promise<string> {
  const { rows } = await database.session.query<{ shifts: string }>(
    'SELECT count(*)::text AS shifts FROM step_execution_shifts WHERE enrollment_id = $1',
    [enrollmentId],
  );
  return JSON.stringify({
    enrollment: await readEnrollment(contextFor('alpha', 'admin'), { enrollmentId }),
    steps: await listStepExecutions(contextFor('alpha', 'admin'), { enrollmentId }),
    shifts: rows[0]?.shifts,
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM active_holds');
});

describe('previewResume (4.3, audit G06)', () => {
  it('shows every unexecuted step nine days later after a nine-day hold, and writes nothing', async () => {
    const enrollmentId = await enrollAlpha();
    await pause(9);
    const before = await snapshot(enrollmentId);

    const preview = await previewResume(contextFor('alpha', 'salesperson'), { enrollmentId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.kind).toBe('resume');
    expect(preview.value.firmTimeZone).toBe('America/New_York');
    expect(preview.value.holds.map(hold => hold.reasonCode)).toEqual(['scoped_pause']);
    expect(preview.value.shiftMilliseconds / DAY).toBeGreaterThan(8.9);
    expect(preview.value.shiftMilliseconds / DAY).toBeLessThan(9.1);
    expect(preview.value.steps).toHaveLength(1);
    const [step] = preview.value.steps;
    expect(step?.channel).toBe('email');
    expect(Date.parse(step?.proposedDueAt ?? '') - Date.parse(step?.dueAt ?? '')).toBe(preview.value.shiftMilliseconds);

    // A read: looking changes nothing.
    expect(await snapshot(enrollmentId)).toBe(before);
  });

  it('shows the dates the confirmation then gives the steps, exactly', async () => {
    const enrollmentId = await enrollAlpha();
    await pause(9);
    const preview = await previewResume(contextFor('alpha', 'salesperson'), { enrollmentId });
    if (!preview.ok) throw new Error(preview.reason);

    const resumed = await resumeEnrollment(contextFor('alpha', 'salesperson'), { enrollmentId });
    // The confirmation is a resume, by the shift the review showed.
    expect(resumed.ok && resumed.value.kind).toBe('resume');
    expect(resumed.ok && resumed.value.shiftMilliseconds).toBe(preview.value.shiftMilliseconds);
    const steps = await listStepExecutions(contextFor('alpha', 'admin'), { enrollmentId });
    expect(steps.map(step => step.dueAt)).toEqual(preview.value.steps.map(step => step.proposedDueAt));
    expect((await readEnrollment(contextFor('alpha', 'admin'), { enrollmentId }))?.state).toBe('active');
  });

  it('says a hold is still open and proposes moving nothing', async () => {
    const enrollmentId = await enrollAlpha();
    const hold = await pause(3, { open: true });
    const preview = await previewResume(contextFor('alpha', 'admin'), { enrollmentId });
    expect(preview.ok && preview.value.kind).toBe('still_held');
    if (!preview.ok) return;
    expect(preview.value.openHoldIds).toEqual([hold]);
    expect(preview.value.shiftMilliseconds).toBe(0);
    expect(preview.value.steps.every(step => step.proposedDueAt === step.dueAt)).toBe(true);
  });

  it('refuses an enrollment of another workspace as unknown, and an ended one as not live', async () => {
    const enrollmentId = await enrollAlpha();
    expect(await previewResume(contextFor('beta', 'admin'), { enrollmentId })).toEqual({
      ok: false,
      reason: 'enrollment_unknown',
    });
    await stopEnrollments(contextFor('alpha', 'admin'), { enrollmentId, reason: 'admin_stop' });
    expect(await previewResume(contextFor('alpha', 'admin'), { enrollmentId })).toEqual({
      ok: false,
      reason: 'enrollment_not_live',
    });
  });
});
