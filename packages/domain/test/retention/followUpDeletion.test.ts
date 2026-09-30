import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { grantFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from '../sequences/support/sequenceFixtures.ts';

/**
 * A documented deletion of a firm that has evidenced follow-up rows (specification 10.3;
 * P1-3 of the GPT-6 review of PR 332).
 *
 * Migration 0025 puts three constraints between a deletion and the rows it removes: an
 * enrollment that is a live `follow_up` must carry a permission, a permission holds its
 * evidence — the call log or the inbound message — undeletable, and the enrollment's
 * pointer is a foreign key onto the permission. The review found the workflow ordered
 * against all three: it cleared the pointer on an *active* row first, which the CHECK
 * refuses, and the whole deletion failed.
 *
 * So the order is the property, and it is tested on the two shapes that exist: a
 * follow-up still running, and one that has already ended.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

const admin = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.admin.userId,
      role: 'admin',
    }),
    database.session,
  );

const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    }),
    database.session,
  );

const count = async (sql: string, values: readonly unknown[]): Promise<number> => {
  const { rows } = await database.session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
};

/** A person at the seeded firm, with a call that agreed to the published sequence. */
async function evidencedFollowUp(name: string): Promise<{ readonly enrollmentId: string; readonly permissionId: string }> {
  const { rows: contacts } = await database.session.query<{ id: string }>(
    'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, crm.alpha.firmId, name],
  );
  const contactId = contacts[0]?.id ?? '';
  const { rows: logs } = await database.session.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
        actor_user_id, agreed_follow_up, agreed_sequence_version_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5,
             'agreed_sequence', $6)
     RETURNING id`,
    [
      seeded.alpha.workspaceId,
      crm.alpha.firmId,
      contactId,
      crm.alpha.opportunityId,
      seeded.alpha.salesperson.userId,
      sequences.alpha.publishedVersionId,
    ],
  );
  const granted = await grantFollowUpPermission(salesperson(), {
    firmId: crm.alpha.firmId,
    contactId,
    callLogId: logs[0]?.id ?? '',
    grantedByUserId: seeded.alpha.salesperson.userId,
  });
  if (!granted.ok) throw new Error(`the permission fixture was refused: ${granted.reason}`);
  const enrolled = await enrollContact(salesperson(), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    originKind: 'follow_up',
    permissionId: granted.value.id,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId,
  });
  if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
  return { enrollmentId: enrolled.value.enrollmentId, permissionId: granted.value.id };
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

describe('deleting a firm that has follow-up permissions', () => {
  it('stops the live follow-up first, then removes the permission and its evidence', async () => {
    const live = await evidencedFollowUp('Still Running');
    // And one that has already finished, so both shapes are in the same commit: the
    // ended row's pointer is cleared under the CHECK's one exemption.
    const ended = await evidencedFollowUp('Already Finished');
    await database.session.query(
      `UPDATE sequence_enrollments
          SET state = 'completed', ended_at = now(), end_reason = 'sequence_complete', updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, ended.enrollmentId],
    );
    await database.session.query(
      `UPDATE step_executions
          SET state = 'completed', completed_at = now(), completion_source = 'send',
              result = 'sent', updated_at = now()
        WHERE workspace_id = $1 AND enrollment_id = $2`,
      [seeded.alpha.workspaceId, ended.enrollmentId],
    );

    const context = admin();
    const preview = await previewDeletion(context, { targetKind: 'firm', firmId: crm.alpha.firmId });
    expect(preview.ok).toBe(true);
    // The permission is named in the preview: it is exactly the kind of row an
    // administrator should be told about before approving its removal.
    expect(preview.value?.removes['follow_up_permissions']).toBeGreaterThanOrEqual(2);

    const outcome = await commitDeletion(context, {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-follow-up-1',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    // Every permission of the firm is gone, and so is the evidence it held.
    expect(
      await count('SELECT count(*) AS count FROM follow_up_permissions WHERE workspace_id = $1 AND firm_id = $2', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS count FROM call_logs WHERE workspace_id = $1 AND firm_id = $2', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
      ]),
    ).toBe(0);

    // The enrollments are retained as history, ended, with no pointer left — which is
    // representable only because they are ended.
    const { rows } = await database.session.query<{
      state: string;
      ended_at: Date | null;
      permission_id: string | null;
      origin_kind: string;
    }>(
      `SELECT state, ended_at, permission_id, origin_kind FROM sequence_enrollments
        WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [seeded.alpha.workspaceId, [live.enrollmentId, ended.enrollmentId]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.ended_at).not.toBeNull();
      expect(row.permission_id).toBeNull();
      expect(row.origin_kind).toBe('follow_up');
      expect(row.state === 'stopped' || row.state === 'completed').toBe(true);
    }
    // Nothing of the live run is claimable any more.
    expect(
      await count(
        `SELECT count(*) AS count FROM step_executions
          WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
        [seeded.alpha.workspaceId, live.enrollmentId],
      ),
    ).toBe(0);
  });
});
