import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { composeEligibility } from '../../sequences/eligibility.ts';
import { enrollContact, stopEnrollments } from '../../sequences/enrollments.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { recordingSendHandoff } from '../../sequences/sendHandoff.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * Suppression outlives the enrollment it stopped (specification 10.2, 11.2; the SP
 * lane's send-path verification, 29 September 2026).
 *
 * `enrollContact` does not ask about suppression: a salesperson may re-enrol a contact
 * who asked to stop, and the command succeeds. What must never happen is a *send*, and
 * the thing that makes that true is `suppressionSource` — the first source of
 * `composeEligibility`, asked when a due step is prepared and again inside the dispatch
 * claim. These two tests pin that: the re-enrolled step holds, and nothing is ever
 * handed to the sending lane.
 *
 * Remove `suppressionSource()` from `defaultEligibilitySources()` and both fail: the
 * step is prepared and the recording hand-off records a request.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    }),
    database.session,
  );

const worker = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
    database.session,
  );

async function enrol(contactId: string): Promise<string> {
  const result = await enrollContact(salesperson(), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    originKind: 'prospecting' as const,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId,
  });
  if (!result.ok) throw new Error(`the enrollment fixture was refused: ${result.reason}`);
  return result.value.enrollmentId;
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
  // Migration 0025: a permission names the one run it bought, so the binding is
  // released before the enrollment it names is deleted.
  await database.session.query('UPDATE follow_up_permissions SET enrollment_id = NULL');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM active_holds');
  await database.session.query('DELETE FROM suppression_finalizations');
  await database.session.query('DELETE FROM suppression_events');
  await database.session.query(
    `UPDATE opportunities SET status = 'open', closed_at = NULL, close_reason = NULL,
            control_mode = 'automated', control_mode_reason = NULL`,
  );
});

describe('a stop request outlives the enrollment it stopped', () => {
  it('holds the first step of a re-enrollment made after the opt-out, and hands nothing to the send', async () => {
    const first = await enrol(crm.alpha.contactId);
    const suppressed = await recordSuppression(salesperson(), {
      scope: 'handle',
      firmId: crm.alpha.firmId,
      value: crm.collidingEmail,
      source: 'prospect_opt_out',
      journal: recordingSuppressionJournal(),
    });
    expect(suppressed.ok).toBe(true);
    await stopEnrollments(worker(), { enrollmentId: first, reason: 'opt_out' });

    // The re-enrollment itself is *not* refused. That is the gap this test documents:
    // the guarantee lives at the send, not at the command.
    const second = await enrol(crm.alpha.contactId);
    expect(second).not.toBe(first);

    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId: second,
      now: await databaseNow(worker()),
      eligibility: composeEligibility(),
      sendHandoff: handoff,
    });
    expect(outcome.kind === 'held' ? outcome.reasonCode : outcome.kind).toBe('handle_suppressed');
    expect(handoff.prepared).toHaveLength(0);
  });

  it('holds a different contact at a firm the prospect suppressed firm-wide', async () => {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, 'Alex Example'],
    );
    const colleague = rows[0]?.id ?? '';
    const enrollmentId = await enrol(colleague);

    const suppressed = await recordSuppression(salesperson(), {
      scope: 'firm',
      firmId: crm.alpha.firmId,
      source: 'prospect_opt_out',
      journal: recordingSuppressionJournal(),
    });
    expect(suppressed.ok).toBe(true);

    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: await databaseNow(worker()),
      eligibility: composeEligibility(),
      sendHandoff: handoff,
    });
    expect(outcome.kind === 'held' ? outcome.reasonCode : outcome.kind).toBe('firm_suppressed');
    expect(handoff.prepared).toHaveLength(0);
  });
});
